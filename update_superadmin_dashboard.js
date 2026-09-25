import fs from 'fs';

let code = fs.readFileSync('src/modules/superAdmin/routes.js', 'utf8');

// Locate the superAdminRouter.get("/dashboard", ...) route
const startRoute = code.indexOf('superAdminRouter.get("/dashboard"');
const endRoute = code.indexOf('superAdminRouter.post("/salons"', startRoute);

if (startRoute === -1 || endRoute === -1) {
  console.error("Could not find /dashboard bounds!");
  process.exit(1);
}

const newDashboardRoute = `superAdminRouter.get("/dashboard", asyncHandler(async (req, res) => {
  const period = String(req.query.period || "lifetime").toLowerCase();
  const now = new Date();
  let startDate = null;
  let endDate = null;

  if (period === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (period === "month") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (period === "year") {
    startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else if (period === "custom") {
    if (req.query.dateFrom) {
      const parts = req.query.dateFrom.split("-");
      startDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0, 0);
    }
    if (req.query.dateTo) {
      const parts = req.query.dateTo.split("-");
      endDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 23, 59, 59, 999);
    }
  } else {
    // "lifetime"
    startDate = null;
    endDate = null;
  }

  const dateFilter = (startDate || endDate) ? {
    ...(startDate ? { gte: startDate } : {}),
    ...(endDate ? { lte: endDate } : {})
  } : null;

  const salonWhere = dateFilter ? { createdAt: dateFilter } : {};
  const leadWhere = dateFilter ? { createdAt: dateFilter } : {};
  const ticketWhere = dateFilter ? { createdAt: dateFilter } : {};

  // Execute database queries
  const [
    totalSalons,
    activeSalons,
    trialSalons,
    expiredSalons,
    suspendedSalons,
    demoLeadsCount,
    activeDemoLeads,
    convertedLeadsCount,
    upcomingDemosCount,
    supportTicketsCount,
    urgentTickets,
    pendingProductRequests,
    pendingStaffRequests,
    plans,
    allSubscriptions,
    recentSalons,
    recentPayments,
    recentLeads,
    recentTickets,
    recentActivityLogs
  ] = await Promise.all([
    prisma.salon.count({ where: salonWhere }),
    prisma.salon.count({ where: { ...salonWhere, status: "ACTIVE" } }),
    prisma.salon.count({ where: { ...salonWhere, status: "TRIAL" } }),
    prisma.salon.count({ where: { ...salonWhere, status: "EXPIRED" } }),
    prisma.salon.count({ where: { status: "SUSPENDED" } }), // Attention item: always show current suspended
    prisma.demoLead.count({ where: leadWhere }),
    prisma.demoLead.count({ where: { ...leadWhere, status: { notIn: ["CONVERTED", "LOST"] } } }),
    prisma.demoLead.count({ where: { ...leadWhere, status: "CONVERTED" } }),
    prisma.demoLead.count({ where: { ...leadWhere, status: "DEMO_SCHEDULED" } }),
    prisma.supportTicket.count({ where: ticketWhere }),
    prisma.supportTicket.findMany({ where: { status: "OPEN", priority: "URGENT" }, take: 5, include: { salon: true } }),
    prisma.productRequirement.count({ where: { status: "OPEN" } }),
    prisma.staffRequirement.count({ where: { status: "OPEN" } }),
    prisma.plan.findMany(),
    prisma.subscription.findMany({ include: { plan: true, salon: true } }),
    prisma.salon.findMany({ where: salonWhere, take: 5, orderBy: { createdAt: "desc" } }),
    prisma.payment.findMany({ where: dateFilter ? { createdAt: dateFilter } : {}, take: 5, orderBy: { createdAt: "desc" } }),
    prisma.demoLead.findMany({ where: leadWhere, take: 5, orderBy: { createdAt: "desc" } }),
    prisma.supportTicket.findMany({ where: ticketWhere, take: 5, orderBy: { createdAt: "desc" }, include: { salon: true } }),
    prisma.auditLog.findMany({ take: 8, orderBy: { createdAt: "desc" } }).catch(() => [])
  ]);

  // Calculate Revenue
  // If period is filtered, calculate revenue collected for subscriptions started/paid in this period
  const subsInPeriod = dateFilter ? allSubscriptions.filter(s => {
    const d = new Date(s.startsAt || s.convertedAt || s.createdAt);
    return (!startDate || d >= startDate) && (!endDate || d <= endDate);
  }) : allSubscriptions;

  const totalSubscriptionRevenue = subsInPeriod.reduce((sum, sub) => {
    return sum + Math.max(0, toAmount(sub.plan?.monthlyPrice || 0) - toAmount(sub.manualDiscount || 0));
  }, 0);

  // MRR: Monthly recurring value of currently active subscriptions
  const monthlySubscriptionRevenue = allSubscriptions
    .filter(sub => sub.status === "ACTIVE")
    .reduce((sum, sub) => sum + Math.max(0, toAmount(sub.plan?.monthlyPrice || 0) - toAmount(sub.manualDiscount || 0)), 0);

  const pendingSubscriptionRevenue = allSubscriptions
    .filter(sub => sub.paymentStatus === "PENDING")
    .reduce((sum, sub) => sum + Math.max(0, toAmount(sub.plan?.monthlyPrice || 0) - toAmount(sub.manualDiscount || 0)), 0);

  const activePlansSummary = plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    monthlyPrice: Number(plan.monthlyPrice),
    yearlyPrice: Number(plan.yearlyPrice)
  }));

  const activeSubCount = allSubscriptions.filter(s => s.status === "ACTIVE").length;
  const trialSubCount = allSubscriptions.filter(s => s.status === "TRIAL").length;
  const expiredSubCount = allSubscriptions.filter(s => s.status === "EXPIRED").length;
  const expiringSubCount = allSubscriptions.filter(s => {
    if (s.status !== "ACTIVE") return false;
    const diffDays = (new Date(s.endsAt).getTime() - Date.now()) / (1000 * 3600 * 24);
    return diffDays >= 0 && diffDays <= 7;
  }).length;

  const pendingPaymentsList = allSubscriptions
    .filter(s => s.paymentStatus === "PENDING")
    .slice(0, 5)
    .map(s => ({
      id: s.id,
      salon: s.salon,
      amount: Math.max(0, toAmount(s.plan?.monthlyPrice || 0) - toAmount(s.manualDiscount || 0))
    }));

  const expiringSalonsList = allSubscriptions
    .filter(s => {
      if (s.status !== "ACTIVE") return false;
      const diffDays = (new Date(s.endsAt).getTime() - Date.now()) / (1000 * 3600 * 24);
      return diffDays >= 0 && diffDays <= 7;
    })
    .slice(0, 5)
    .map(s => ({
      salonId: s.salonId,
      salonName: s.salon?.name || "Salon",
      endsAt: s.endsAt
    }));

  res.json({
    totalSalons,
    activeSalons,
    trialSalons,
    expiredSalons,
    suspendedSalons,
    demoLeadsCount,
    activeDemoLeads,
    convertedLeadsCount,
    upcomingDemosCount,
    plansCount: plans.length,
    totalSubscriptionRevenue,
    monthlySubscriptionRevenue,
    pendingSubscriptionRevenue,
    supportTicketsCount,
    pendingProductRequests,
    pendingStaffRequests,
    activePlansSummary,
    expiredSubscriptionsSummary: expiredSubCount,
    subscriptionStatusSummary: {
      active: activeSubCount,
      trial: trialSubCount,
      expiring: expiringSubCount,
      expired: expiredSubCount
    },
    attentionRequired: {
      urgentTickets: urgentTickets.map(t => ({ id: t.id, subject: t.subject, salonName: t.salon?.name })),
      suspendedCount: suspendedSalons,
      pendingProductRequests,
      pendingStaffRequests,
      pendingPayments: pendingPaymentsList,
      expiringSalons: expiringSalonsList
    },
    recentSalons,
    recentPayments,
    recentLeads,
    recentTickets,
    recentActivity: recentActivityLogs,
    period,
    dateRange: { startDate, endDate }
  });
}));

`;

code = code.substring(0, startRoute) + newDashboardRoute + code.substring(endRoute);
fs.writeFileSync('src/modules/superAdmin/routes.js', code);
console.log("Updated superAdmin dashboard route with full dynamic period filter!");
