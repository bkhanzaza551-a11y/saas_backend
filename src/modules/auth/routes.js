import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { signAccessToken, signRefreshToken, verifyLoginAccessToken, verifyRefreshToken, verifyAccessToken } from "../../lib/tokens.js";
import { validate, schemas } from "../../middlewares/validate.js";
import { hashPasswordSetupToken, generateRawPasswordSetupToken } from "../../lib/passwordSetup.js";
import { sendMail } from "../../lib/mailer.js";
import { defaultOwnerPermissions } from "../../lib/permissions.js";
import { runExpiredDemoCleanup } from "../../lib/trialCleanup.js";

export const authRouter = Router();

authRouter.post("/verify-security-pin", async (req, res) => {
  res.json({ success: true, token: "mock-token-after-pin" });
});
authRouter.post("/forgot-security-pin", async (req, res) => {
  res.json({ success: true, message: "OTP sent" });
});
authRouter.post("/verify-otp", async (req, res) => {
  res.json({ success: true, message: "OTP verified" });
});
authRouter.post("/switch-salon", async (req, res) => {
  res.json({ success: true, token: "mock-token-switch" });
});
authRouter.post("/resend-otp", async (req, res) => {
  res.json({ success: true, message: "OTP resent" });
});


const membershipPriority = {
  SALON_OWNER: 1,
  ADMIN: 2,
  MANAGER: 3,
  RECEPTIONIST: 4,
  STAFF: 5,
  INVENTORY_MANAGER: 6,
  ACCOUNTANT: 7
};

const sortMemberships = (memberships = []) =>
  [...memberships].sort((left, right) => {
    const roleDiff = (membershipPriority[left.salonRole] || 99) - (membershipPriority[right.salonRole] || 99);
    if (roleDiff !== 0) return roleDiff;
    return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
  });

authRouter.post("/register", validate(schemas.register), async (req, res) => {
  const { name, email, password, systemRole = "SALON_USER", salonId } = req.body;
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(400).json({ message: "Email already exists" });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, passwordHash, systemRole } });

  if (salonId && systemRole === "SALON_USER") {
    await prisma.userSalon.create({
      data: {
        userId: user.id,
        salonId,
        salonRole: "SALON_OWNER",
        permissions: defaultOwnerPermissions
      }
    });
  }

  res.status(201).json({ id: user.id, email: user.email });
});

const createAuthResponse = async (user) => {
  const activeMemberships = sortMemberships((user.memberships || []).filter(m => m?.salon?.status !== "SUSPENDED"));
  const membership = activeMemberships[0] || null;

  if (membership?.salonId) {
    await runExpiredDemoCleanup({ actorName: "LOGIN_CHECK", salonId: membership.salonId }).catch(() => {});
  }

  if (user.systemRole !== "SUPER_ADMIN" && !membership) {
    return { errorStatus: 403, errorBody: { message: "No active salon membership is linked to this email." } };
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

  return {
    success: true,
    data: {
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
    }
  };
};

authRouter.post("/login", validate(schemas.login), async (req, res) => {
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

  // SuperAdmin directly logs in without OTP
  if (user.systemRole === "SUPER_ADMIN") {
    const authRes = await createAuthResponse(user);
    if (authRes.errorStatus) return res.status(authRes.errorStatus).json(authRes.errorBody);
    return res.json(authRes.data);
  }

  // --- OTP Logic for Salon Owner & Staff ---
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
    text: `Your OTP for login is ${otp}. It is valid for 10 minutes.`,
    html: `<p>Your OTP for login is <strong>${otp}</strong>.</p><p>It is valid for 10 minutes.</p>`
  }).catch(e => console.error("OTP Email failed", e));

  // Return requiring OTP + include OTP for testing
  return res.json({
    requireOtp: true,
    email: user.email,
    otp: otp,
    message: `OTP sent to your email. (Testing: ${otp})`
  });
});

authRouter.post("/verify-otp", async (req, res) => {
  const { email, tempToken, otp } = req.body;
  if (!otp) return res.status(400).json({ message: "OTP is required" });

  let cleanEmail = String(email || tempToken || "").trim().toLowerCase();
  
  let user = null;
  if (cleanEmail && cleanEmail.includes("@")) {
    user = await prisma.user.findFirst({
      where: { email: { equals: cleanEmail, mode: "insensitive" } },
      include: {
        memberships: {
          include: {
            salon: {
              select: { id: true, status: true, featureFlags: true, name: true }
            }
          }
        }
      }
    });
  }

  // Fallback: If email wasn't provided, find user by active loginOtp
  if (!user) {
    user = await prisma.user.findFirst({
      where: { loginOtp: String(otp).trim() },
      include: {
        memberships: {
          include: {
            salon: {
              select: { id: true, status: true, featureFlags: true, name: true }
            }
          }
        }
      }
    });
  }

  if (!user) return res.status(400).json({ message: "Invalid OTP or user not found" });

  if (user.loginOtp !== String(otp).trim() || !user.loginOtpExpiry || user.loginOtpExpiry < new Date()) {
    return res.status(400).json({ message: "Invalid or expired OTP" });
  }

  // Clear OTP
  await prisma.user.update({
    where: { id: user.id },
    data: { loginOtp: null, loginOtpExpiry: null }
  });

  const authRes = await createAuthResponse(user);
  if (authRes.errorStatus) return res.status(authRes.errorStatus).json(authRes.errorBody);
  return res.json(authRes.data);
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
    text: `Your OTP for login is ${otp}. It is valid for 10 minutes.`,
    html: `<p>Your OTP for login is <strong>${otp}</strong>.</p><p>It is valid for 10 minutes.</p>`
  }).catch(e => console.error("OTP Email failed", e));

  return res.json({
    success: true,
    email: user.email,
    otp: otp,
    message: `A new OTP has been sent. (Testing: ${otp})`
  });
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

authRouter.get("/me", async (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Authentication required" });

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    include: { memberships: { include: { salon: { select: { id: true, name: true, slug: true, status: true, featureFlags: true } } } } }
  });
  if (!user || !user.isActive) return res.status(401).json({ message: "Invalid user" });

  const activeMemberships = sortMemberships(
    (user.memberships || []).filter((membership) => membership?.salon?.status !== "SUSPENDED")
  );
  const membership = decoded.salonId
    ? activeMemberships.find((item) => item.salonId === decoded.salonId)
    : (activeMemberships[0] || null);

  const subscription = membership?.salonId
    ? await prisma.subscription.findFirst({
        where: { salonId: membership.salonId, status: { in: ["ACTIVE", "TRIAL"] } },
        include: { plan: true },
        orderBy: { endsAt: "desc" }
      })
    : null;

  const mergedFeatureFlags = {
    ...(subscription?.plan?.featureFlags || {}),
    ...(membership?.salon?.featureFlags || {})
  };
  const mergedPermissions = membership
    ? membership.salonRole === "SALON_OWNER"
      ? { ...defaultOwnerPermissions, ...(membership.permissions || {}) }
      : (await (async () => {
          if (membership.customRoleId) {
            const customRole = await prisma.customRole.findFirst({ where: { id: membership.customRoleId, salonId: membership.salonId } });
            if (customRole) return { ...(membership.permissions || {}), ...(customRole.permissions || {}) };
          }
          return membership.permissions || {};
        })())
    : null;

  const serializeMembership = (item) => ({
    salonId: item.salonId,
    salonName: item.salon?.name || null,
    salonSlug: item.salon?.slug || null,
    salonRole: item.salonRole,
    branchId: item.branchId || null,
    customRoleId: item.customRoleId || null,
    permissions: item.salonRole === "SALON_OWNER" ? { ...defaultOwnerPermissions, ...(item.permissions || {}) } : (item.permissions || {}),
    featureFlags: item.salonId === membership?.salonId ? mergedFeatureFlags : (item.salon?.featureFlags || {}),
    salon: item.salon || null,
    plan: item.salonId === membership?.salonId
      ? (subscription?.plan
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
          : null)
      : null
  });

  return res.json({
    user: { id: user.id, name: user.name, email: user.email, systemRole: user.systemRole },
    membership: membership ? { ...serializeMembership(membership), permissions: mergedPermissions, featureFlags: mergedFeatureFlags } : null,
    activeMemberships: activeMemberships.map(serializeMembership)
  });
});

authRouter.post("/forgot-password", validate(schemas.forgotPassword), async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      memberships: {
        include: {
          salon: true
        }
      }
    }
  });

  if (!user) {
    return res.json({ message: "If this email exists in the system, a password setup email has been sent." });
  }

  const primaryMembership = user.memberships[0] || null;
  const rawToken = generateRawPasswordSetupToken();
  const tokenHash = hashPasswordSetupToken(rawToken);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

  await prisma.passwordSetupToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt
    }
  });

  const frontendUrl = process.env.FRONTEND_APP_URL || "https://saas-frontend-delta-one.vercel.app";
  const resetLink = `${frontendUrl}/reset-password?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(user.email)}`;
  const loginLink = `${frontendUrl}/login?email=${encodeURIComponent(user.email)}`;

  await sendMail({
    to: user.email,
    subject: "Reset your Skillify password",
    text: `Hi ${user.name},\n\nUse this secure link to set a new password:\n${resetLink}\n\nLogin page:\n${loginLink}\n`,
    html: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f7f4ef;color:#18212c;"><div style="max-width:620px;margin:0 auto;background:#fff;border-radius:24px;padding:28px;"><h2>Reset your password</h2><p>Hi ${user.name}, use the secure link below to choose a new password for your Skillify account.</p><p><a href="${resetLink}" style="display:inline-block;background:#0f766e;color:#fff;padding:14px 18px;border-radius:999px;text-decoration:none;font-weight:700;">Set new password</a></p><p style="font-size:14px;">Login page: <a href="${loginLink}">${loginLink}</a></p></div></div>`
  });

  return res.json({ message: "If this email exists in the system, a password setup email has been sent." });
});

authRouter.post("/validate-reset-token", validate(schemas.validateResetToken), async (req, res) => {
  const tokenHash = hashPasswordSetupToken(req.body.token);
  const token = await prisma.passwordSetupToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          memberships: true
        }
      }
    }
  });

  if (!token || token.usedAt || token.expiresAt < new Date()) {
    return res.status(400).json({ message: "This password setup link is invalid or expired." });
  }

  return res.json({
    valid: true,
    email: token.user.email,
    name: token.user.name
  });
});

authRouter.post("/reset-password", validate(schemas.resetPassword), async (req, res) => {
  const tokenHash = hashPasswordSetupToken(req.body.token);
  const token = await prisma.passwordSetupToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          memberships: true
        }
      }
    }
  });

  if (!token || token.usedAt || token.expiresAt < new Date()) {
    return res.status(400).json({ message: "This password setup link is invalid or expired." });
  }

  const passwordHash = await bcrypt.hash(req.body.password, 10);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: token.userId },
      data: {
        passwordHash,
        passwordSetupRequired: false
      }
    }),
    prisma.passwordSetupToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() }
    })
  ]);

  return res.json({
    message: "Password has been set successfully. You can now login.",
    email: token.user.email
  });
});
