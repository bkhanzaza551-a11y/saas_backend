import fs from 'fs';

let code = fs.readFileSync('src/modules/auth/routes.js', 'utf8');

const loginStart = code.indexOf('authRouter.post("/login"');
const getMeStart = code.indexOf('authRouter.get("/me"'); // we will replace everything from /login to /me

if (loginStart === -1 || getMeStart === -1) {
  console.log("Could not find bounds");
  process.exit(1);
}

const replacement = `authRouter.post("/login", validate(schemas.login), async (req, res) => {
  const { email, password, loginAccessToken } = req.body;
  const cleanEmail = String(email || "").trim().toLowerCase();
  const user = await prisma.user.findFirst({
    where: { email: { equals: cleanEmail, mode: "insensitive" } },
    include: {
      memberships: {
        include: {
          salon: {
            select: { id: true, status: true, featureFlags: true }
          }
        }
      }
    }
  });
  if (!user) return res.status(401).json({ message: "Invalid credentials" });
  if (user.isActive === false) return res.status(403).json({ message: "User account is inactive" });
  if (user.passwordSetupRequired) return res.status(403).json({ message: "Password setup is still pending." });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  if (user.systemRole !== "SUPER_ADMIN") {
    const globalSetting = await prisma.globalSetting.findFirst();
    if (globalSetting?.maintenanceMode) {
      return res.status(503).json({ message: "System is in maintenance mode" });
    }
  }

  // --- OTP Logic ---
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

  await prisma.user.update({
    where: { id: user.id },
    data: { loginOtp: otp, loginOtpExpiry: otpExpiry }
  });

  // Send OTP to email
  await sendMail({
    to: user.email,
    subject: "Your Login OTP",
    text: \`Your OTP for login is \${otp}. It is valid for 10 minutes.\`,
    html: \`<p>Your OTP for login is <strong>\${otp}</strong>.</p><p>It is valid for 10 minutes.</p>\`
  }).catch(e => console.error("OTP Email failed", e));

  // Return requiring OTP
  return res.json({ requireOtp: true, email: user.email, message: "OTP sent to your email" });
});

authRouter.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required" });

  const cleanEmail = String(email).trim().toLowerCase();
  const user = await prisma.user.findFirst({
    where: { email: { equals: cleanEmail, mode: "insensitive" } },
    include: {
      memberships: {
        include: {
          salon: {
            select: { id: true, status: true, featureFlags: true }
          }
        }
      }
    }
  });

  if (!user) return res.status(400).json({ message: "Invalid request" });
  
  if (user.loginOtp !== String(otp) || !user.loginOtpExpiry || user.loginOtpExpiry < new Date()) {
    return res.status(400).json({ message: "Invalid or expired OTP" });
  }

  // Clear OTP
  await prisma.user.update({
    where: { id: user.id },
    data: { loginOtp: null, loginOtpExpiry: null }
  });

  // Proceed with standard login token generation
  const activeMemberships = sortMemberships((user.memberships || []).filter(m => m?.salon?.status !== "SUSPENDED"));
  const membership = activeMemberships[0] || null;

  if (membership?.salonId) {
    await runExpiredDemoCleanup({ actorName: "LOGIN_CHECK", salonId: membership.salonId }).catch(()=>{});
  }

  if (user.systemRole !== "SUPER_ADMIN" && !membership) {
    return res.status(403).json({ message: "No active salon membership is linked to this email." });
  }

  const [salon, subscription] = membership
    ? await Promise.all([
        prisma.salon.findUnique({ where: { id: membership.salonId }, select: { name: true, featureFlags: true } }),
        prisma.subscription.findFirst({
          where: { salonId: membership.salonId, status: { in: ["ACTIVE", "TRIAL"] } },
          include: { plan: true },
          orderBy: { endsAt: "desc" }
        })
      ])
    : [null, null];

  const resolvedSalonId = membership?.salonId || null;
  const accessToken = signAccessToken({ userId: user.id, salonId: resolvedSalonId });
  const refreshToken = signRefreshToken({ userId: user.id, salonId: resolvedSalonId });
  
  const mergedFeatureFlags = {
    ...(subscription?.plan?.featureFlags || {}),
    ...(salon?.featureFlags || {})
  };
  
  const mergedPermissions = membership
    ? membership.salonRole === "SALON_OWNER"
      ? { ...defaultOwnerPermissions, ...(membership.permissions || {}) }
      : (await (async () => {
          if (membership.customRoleId) {
            const customRole = await prisma.customRole.findFirst({ where: { id: membership.customRoleId, salonId: membership.salonId } });
            if (customRole) {
              return { ...(membership.permissions || {}), ...(customRole.permissions || {}) };
            }
          }
          return membership.permissions || {};
        })())
    : null;

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, systemRole: user.systemRole },
    membership: membership
      ? {
          salonId: membership.salonId,
          salonName: salon?.name || membership.salon?.name || null,
          salonRole: membership.salonRole,
          branchId: membership.branchId || null,
          customRoleId: membership.customRoleId || null,
          permissions: mergedPermissions || {},
          featureFlags: mergedFeatureFlags,
          plan: subscription?.plan
            ? {
                id: subscription.plan.id,
                name: subscription.plan.name,
                branchLimit: subscription.plan.branchLimit,
                userLimit: subscription.plan.userLimit,
                customerLimit: subscription.plan.customerLimit,
                invoiceLimit: subscription.plan.invoiceLimit,
                storageLimit: subscription.plan.storageLimit,
                isCustom: subscription.plan.isCustom
              }
            : null
        }
      : null
  });
});

authRouter.post("/resend-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });
  const cleanEmail = String(email).trim().toLowerCase();
  const user = await prisma.user.findFirst({ where: { email: { equals: cleanEmail, mode: "insensitive" } } });
  if (!user) return res.status(400).json({ message: "Invalid request" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: { loginOtp: otp, loginOtpExpiry: otpExpiry }
  });

  await sendMail({
    to: user.email,
    subject: "Your Login OTP",
    text: \`Your OTP for login is \${otp}. It is valid for 10 minutes.\`,
    html: \`<p>Your OTP for login is <strong>\${otp}</strong>.</p><p>It is valid for 10 minutes.</p>\`
  }).catch(e => console.error("OTP Email failed", e));

  res.json({ success: true, message: "OTP resent to your email" });
});

authRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  try {
    const decoded = verifyRefreshToken(refreshToken);
    const accessToken = signAccessToken({ userId: decoded.userId, salonId: decoded.salonId || null });
    return res.json({ accessToken });
  } catch {
    return res.status(401).json({ message: "Invalid refresh token" });
  }
});

authRouter.post("/logout", async (req, res) => res.json({ ok: true }));

`;

code = code.substring(0, loginStart) + replacement + code.substring(getMeStart);
fs.writeFileSync('src/modules/auth/routes.js', code);
console.log("Replaced successfully!");
