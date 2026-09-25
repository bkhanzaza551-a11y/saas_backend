import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { attachBranchStock, buildCsv } from "../../lib/phase2.js";
import { createAuditLog } from "../../lib/phase4.js";
import { patchRouterForAsync } from "../../lib/async-handler.js";
import { requireAuth, requireMaintenanceAccess, requireSalonContext, requireSalonPermission } from "../../middlewares/rbac.js";
import { schemas, validate } from "../../middlewares/validate.js";
import multer from "multer";
import ExcelJS from "exceljs";

import { registerPhase2OwnerRoutes } from "./phase2/index.js";
import { registerPhase3OwnerRoutes } from "./phase3/index.js";
import { registerPhase4OwnerRoutes } from "./phase4/index.js";
import { registerMissingOwnerRoutes } from "./missingOwnerRoutes.js";
import { getCampaignAudience } from "../../lib/phase3.js";

export const ownerRouter = Router();
patchRouterForAsync(ownerRouter);

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

ownerRouter.use(requireAuth, requireMaintenanceAccess, requireSalonContext, async (req, res, next) => {
  if (req.user?.salonRole && req.user.salonRole !== "SALON_OWNER") {
    if (!req.user.branchId) {
      const firstBranch = await prisma.branch.findFirst({ where: { salonId: req.user.salonId, isActive: true }, orderBy: { createdAt: "asc" } });
      if (firstBranch) {
        await prisma.userSalon.update({ where: { id: req.user.membershipId }, data: { branchId: firstBranch.id } });
        req.user.branchId = firstBranch.id;
      }
    }
    const merged = { ...STAFF_SELF_SERVICE_DEFAULTS, ...(req.user.permissions || {}), notifications: Array.from(new Set([...(req.user.permissions?.notifications || []), "view", "edit"])) };
    req.user.permissions = merged;
    if (req.user.branchId) {
      req.query.branchId = req.user.branchId;
      req.branchId = req.user.branchId;
      if (req.body && typeof req.body === "object") {
        req.body.branchId = req.user.branchId;
      }
    }
  }
  next();
});

const forceBranchForUploads = (req, res, next) => {
  if (req.user?.salonRole && req.user.salonRole !== "SALON_OWNER" && req.user.branchId) {
    if (req.body && typeof req.body === "object") {
      req.body.branchId = req.user.branchId;
    }
  }
  next();
};

const findScoped = (model, salonId, id) => prisma[model].findFirst({ where: { id, salonId } });
const toAmount = (value) => Number(value || 0);
const normalizeBranchId = (value) => {
  if (!value || value === "undefined" || value === "null" || value === "ALL") return null;
  return String(value);
};
const withBranchFilter = (salonId, branchId, req) => {
  if (req?.user?.salonRole && req.user.salonRole !== "SALON_OWNER" && req.user.branchId) {
    return { salonId, branchId: req.user.branchId };
  }
  return { salonId, ...(branchId ? { branchId } : {}) };
};
const paymentWhere = (salonId, branchId, req) => {
  const branchFilter = req?.user?.salonRole && req.user.salonRole !== "SALON_OWNER" && req.user.branchId
    ? { branchId: req.user.branchId }
    : (branchId ? { branchId } : {});
  return { salonId, invoice: { is: branchFilter } };
};

const ensureBranch = async (salonId, branchId) => {
  if (!branchId) return null;
  const branch = await prisma.branch.findFirst({ where: { id: branchId, salonId, isActive: true } });
  if (!branch) {
    const error = new Error("Active branch not found");
    error.status = 400;
    throw error;
  }
  return branch;
};

const normalizeDateValue = (value) => (value ? new Date(value) : null);
const sanitizeTagList = (value) => Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
const buildCustomerData = (payload, salonId) => ({
  name: payload.name,
  phone: payload.phone,
  email: payload.email || null,
  gender: payload.gender || null,
  dateOfBirth: normalizeDateValue(payload.dateOfBirth),
  anniversary: normalizeDateValue(payload.anniversary),
  source: payload.source || null,
  tags: sanitizeTagList(payload.tags),
  notes: payload.notes || null,
  preferences: payload.preferences || null,
  preferredStaffId: payload.preferredStaffId || null,
  allergies: payload.allergies || null,
  skinNotes: payload.skinNotes || null,
  branchId: payload.branchId || null,
  ...(salonId ? { salonId } : {})
});

const updateCustomerHandler = async (req, res) => {
  const row = await findScoped("customer", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Customer not found" });

  if (req.body.phone) {
    const duplicate = await prisma.customer.findFirst({
      where: { salonId: req.salonId, phone: req.body.phone, NOT: { id: req.params.id } }
    });
    if (duplicate) return res.status(400).json({ message: "Another customer already uses this phone number" });
  }

  if (req.body.branchId) await ensureBranch(req.salonId, req.body.branchId);

  res.json(await prisma.customer.update({
    where: { id: req.params.id },
    data: buildCustomerData(req.body)
  }));
};

const STAFF_SELF_SERVICE_DEFAULTS = {
  myDashboard: ["view"],
  myAttendance: ["view", "create", "edit"],
  myAppointments: ["view"],
  mySchedule: ["view"],
  myProfile: ["view", "edit"],
  attendance: ["view", "create", "edit"],
  appointments: ["view"],
  customers: ["view"],
  feedback: ["view"],
  branches: ["view"],
  notifications: ["view", "edit"],
  enquiries: ["view", "create", "edit"],
  reports: ["view"],
  support: ["view"]
};

const resolveMembershipPermissions = async (salonId, customRoleId, explicitPermissions) => {
  let role = null;
  if (customRoleId) {
    role = await prisma.customRole.findFirst({ where: { id: customRoleId, salonId } });
    if (!role) {
      const error = new Error("Custom role not found");
      error.status = 400;
      throw error;
    }
  }
  let base;
  if (role) {
    base = { ...STAFF_SELF_SERVICE_DEFAULTS, ...(role.permissions || {}) };
  } else if (explicitPermissions && Object.keys(explicitPermissions).length > 0) {
    base = { ...STAFF_SELF_SERVICE_DEFAULTS, ...explicitPermissions };
  } else {
    base = { ...STAFF_SELF_SERVICE_DEFAULTS };
  }
  for (const [k, v] of Object.entries(base)) { if (Array.isArray(v)) base[k] = v.filter((a) => a !== "delete"); }
  return base;
};

const createLoginUserForSalon = async (salonId, payload) => {
  const {
    name, email, password, salonRole, branchId: rawBranchId, customRoleId, permissions,
    phone, profileNote, avatarUrl, roleTitle, showInCatalog, serviceIds = [],
    attendanceEnabled, attendanceEnrollmentPhotoUrl,
    joiningDate, designation, uanNumber, reportingToId, workingHours, shiftId,
    bankName, bankBranch, accountNumber, ifscCode
  } = payload;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { status: 400, body: { message: "Email already exists" } };

  if (phone) {
    const existingPhone = await prisma.userSalon.findFirst({ where: { salonId, phone, isArchived: false } });
    if (existingPhone) return { status: 400, body: { message: "Another staff member already uses this phone number" } };
  }

  let branchId = normalizeBranchId(rawBranchId);
  if (!branchId) {
    const firstBranch = await prisma.branch.findFirst({ where: { salonId, isActive: true }, orderBy: { createdAt: "asc" } });
    if (firstBranch) branchId = firstBranch.id;
  }
  if (branchId) await ensureBranch(salonId, branchId);
  const resolvedPermissions = await resolveMembershipPermissions(salonId, customRoleId, permissions);

  if (serviceIds.length) {
    const services = await prisma.service.findMany({ where: { id: { in: serviceIds }, salonId, isActive: true } });
    if (services.length !== serviceIds.length) {
      return { status: 400, body: { message: "One or more assigned services are invalid for this salon" } };
    }
    if (branchId) {
      const invalidService = services.find((service) => service.branchId && service.branchId !== branchId);
      if (invalidService) return { status: 400, body: { message: "Assigned services must belong to the selected branch or be branch-shared" } };
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        systemRole: "SALON_USER"
      }
    });

    const membership = await tx.userSalon.create({
      data: {
        userId: user.id,
        salonId,
        salonRole,
        branchId,
        customRoleId: customRoleId || null,
        phone: phone || null,
        profileNote: profileNote || null,
        avatarUrl: avatarUrl || null,
        roleTitle: roleTitle || null,
        showInCatalog: Boolean(showInCatalog),
        attendanceEnabled: Boolean(attendanceEnabled),
        attendanceEnrollmentPhotoUrl: attendanceEnrollmentPhotoUrl || null,
        attendanceEnrollmentCapturedAt: attendanceEnrollmentPhotoUrl ? new Date() : null,
        permissions: resolvedPermissions,
        joiningDate: joiningDate ? new Date(joiningDate) : null,
        designation: designation || null,
        uanNumber: uanNumber || null,
        reportingToId: reportingToId || null,
        workingHours: workingHours || null,
        shiftId: shiftId || null,
        bankName: bankName || null,
        bankBranch: bankBranch || null,
        accountNumber: accountNumber || null,
        ifscCode: ifscCode || null
      },
      include: { user: true, branch: true, customRole: true }
    });

    if (serviceIds.length) {
      await tx.staffServiceAssignment.createMany({
        data: serviceIds.map((serviceId) => ({ userSalonId: membership.id, serviceId })),
        skipDuplicates: true
      });
    }

    return tx.userSalon.findUnique({
      where: { id: membership.id },
      include: { user: true, branch: true, customRole: true, shift: true, serviceAssignments: { include: { service: true } } }
    });
  });

  return { status: 201, body: { membership: created } };
};

ownerRouter.get("/dashboard", requireSalonPermission("dashboard", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoiceWhere = withBranchFilter(req.salonId, branchId, req);
  const serviceWhere = { salonId: req.salonId, isActive: true, ...(branchId ? { branchId } : {}) };
  const userWhere = { salonId: req.salonId, ...(branchId ? { branchId } : {}) };
  const branchWhere = { salonId: req.salonId, isActive: true };
  const appointmentWhere = {
    salonId: req.salonId,
    ...(branchId ? { branchId } : {})
  };
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  const activeAppointmentStatuses = ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"];

  const [customers, services, invoices, users, branches, recentInvoices, recentCustomers, allInvoices, recentPayments, todayAppointments, upcomingAppointments, inventoryProducts, todayInvoices, todayExpenses, todayAppointmentsList, todayPayments] = await Promise.all([
    prisma.customer.count({ where: { salonId: req.salonId, ...(branchId ? { branchId } : {}) } }),
    prisma.service.count({ where: serviceWhere }),
    prisma.invoice.count({ where: invoiceWhere }),
    prisma.userSalon.count({ where: userWhere }),
    prisma.branch.count({ where: branchWhere }),
    prisma.invoice.findMany({ where: invoiceWhere, take: 5, include: { customer: true, branch: true }, orderBy: { createdAt: "desc" } }),
    prisma.customer.findMany({ where: { salonId: req.salonId, ...(branchId ? { branchId } : {}) }, take: 5, orderBy: { createdAt: "desc" } }),
    prisma.invoice.findMany({ where: { ...invoiceWhere, status: { in: ["PAID", "PARTIAL"] } }, include: { branch: true } }),
    prisma.payment.findMany({ where: paymentWhere(req.salonId, branchId, req), take: 5, include: { invoice: true }, orderBy: { createdAt: "desc" } }),
    prisma.appointment.count({
      where: {
        ...appointmentWhere,
        startAt: { gte: startOfDay, lt: endOfDay },
        status: { in: activeAppointmentStatuses }
      }
    }),
    prisma.appointment.count({
      where: {
        ...appointmentWhere,
        startAt: { gte: new Date() },
        status: { in: activeAppointmentStatuses }
      }
    }),
    prisma.product.findMany({
      where: {
        salonId: req.salonId,
        isActive: true,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }, { stockMovements: { some: { branchId } } }] } : {})
      },
      include: { category: true, branch: true }
    }),
    prisma.invoice.findMany({
      where: {
        ...invoiceWhere,
        status: { in: ["PAID", "PARTIAL"] },
        createdAt: { gte: startOfDay, lt: endOfDay }
      },
      include: { items: true, payments: true }
    }),
    prisma.expense.findMany({
      where: {
        salonId: req.salonId,
        ...(branchId ? { branchId } : {}),
        expenseDate: { gte: startOfDay, lt: endOfDay }
      }
    }),
    prisma.appointment.findMany({
      where: {
        ...appointmentWhere,
        startAt: { gte: startOfDay, lt: endOfDay }
      }
    }),
    prisma.payment.findMany({
      where: {
        salonId: req.salonId,
        createdAt: { gte: startOfDay, lt: endOfDay },
        ...(branchId ? { invoice: { branchId } } : {})
      }
    })
  ]);

  const todaySales = allInvoices.filter((item) => new Date(item.createdAt) >= startOfDay).reduce((sum, item) => sum + toAmount(item.total), 0);
  const monthlySales = allInvoices.filter((item) => new Date(item.createdAt) >= startOfMonth).reduce((sum, item) => sum + toAmount(item.total), 0);
  const totalPaid = allInvoices.reduce((sum, item) => sum + toAmount(item.paidAmount), 0);
  const totalDue = allInvoices.reduce((sum, item) => sum + Math.max(0, toAmount(item.total) - toAmount(item.paidAmount)), 0);
  const branchScopedProducts = await attachBranchStock(prisma, inventoryProducts, branchId);
  const lowStockAlertCount = branchScopedProducts.filter((product) => toAmount(product.currentStock) <= toAmount(product.minStock)).length;
  const lowStockProducts = branchScopedProducts
    .filter((product) => toAmount(product.currentStock) <= toAmount(product.minStock))
    .map((product) => ({ id: product.id, name: product.name, currentStock: toAmount(product.currentStock), minStock: toAmount(product.minStock), unit: product.unit || "pcs" }));

  // Today Totals Breakdown
  const todayServicesRevenue = todayInvoices
    .flatMap(inv => inv.items || [])
    .filter(item => item.itemType === "SERVICE" || (item.serviceId && !item.productId))
    .reduce((sum, item) => sum + toAmount(item.lineTotal), 0);
  const todayProductsRevenue = todayInvoices
    .flatMap(inv => inv.items || [])
    .filter(item => item.itemType === "PRODUCT" || item.productId)
    .reduce((sum, item) => sum + toAmount(item.lineTotal), 0);
  const todayExpensesTotal = todayExpenses.reduce((sum, exp) => sum + toAmount(exp.amount), 0);

  // Appointments For Today Breakdown
  const apptsAll = todayAppointmentsList.length;
  const apptsUpcoming = todayAppointmentsList.filter(a => a.status === "CONFIRMED" || a.status === "PENDING").length;
  const apptsOngoing = todayAppointmentsList.filter(a => a.status === "IN_PROGRESS" || a.status === "CHECKED_IN").length;
  const apptsCompleted = todayAppointmentsList.filter(a => a.status === "COMPLETED").length;
  const apptsNoShow = todayAppointmentsList.filter(a => a.status === "NO_SHOW").length;

  // Finance For Today
  let financeCard = 0;
  let financeCash = 0;
  let financeUpi = 0;
  let financeOthers = 0;

  for (const pay of todayPayments) {
    const amt = toAmount(pay.amount);
    const mode = String(pay.mode || "").toUpperCase();
    if (mode === "CARD") {
      financeCard += amt;
    } else if (mode === "CASH") {
      financeCash += amt;
    } else if (mode === "UPI" || mode === "ONLINE") {
      financeUpi += amt;
    } else {
      financeOthers += amt;
    }
  }

  res.json({
    customers,
    services,
    invoices,
    users,
    branches,
    branchFilter: branchId,
    todaySales,
    monthlySales,
    paymentSummary: { totalPaid, totalDue },
    upcomingAppointments,
    todayAppointments,
    lowStockAlertCount,
    lowStockProducts,
    recentInvoices,
    recentCustomers,
    recentPayments,

    // KPI Cards For Today
    todayOverview: {
      totalSales: todaySales,
      services: todayServicesRevenue,
      products: todayProductsRevenue,
      expenses: todayExpensesTotal
    },
    todayAppointmentsBreakdown: {
      all: apptsAll,
      upcoming: apptsUpcoming,
      ongoing: apptsOngoing,
      completed: apptsCompleted,
      noShow: apptsNoShow
    },
    todayFinance: {
      card: financeCard,
      cash: financeCash,
      upi: financeUpi,
      others: financeOthers
    }
  });
});

ownerRouter.get("/global-search", requireSalonPermission("customers", "view"), async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json({ results: [] });

  const salonId = req.salonId;
  const term = { contains: q, mode: "insensitive" };
  const branchId = normalizeBranchId(req.query.branchId);
  const branchFilter = branchId ? { branchId } : {};

  const safe = (promise) => promise.catch(() => []);

  const [customers, services, products, staff, appointments, invoices, memberships, packages] = await Promise.all([
    safe(prisma.customer.findMany({
      where: { salonId, ...branchFilter, OR: [{ name: term }, { phone: term }, { email: term }] },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, phone: true, email: true }
    })),
    safe(prisma.service.findMany({
      where: { salonId, isActive: true, ...branchFilter, OR: [{ name: term }, { serviceTag: term }] },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, price: true, category: { select: { name: true } } }
    })),
    safe(prisma.product.findMany({
      where: { salonId, isActive: true, ...branchFilter, OR: [{ name: term }, { sku: term }] },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, sku: true, sellingPrice: true, currentStock: true }
    })),
    safe(prisma.userSalon.findMany({
      where: { salonId, ...branchFilter, user: { name: term } },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, user: { select: { name: true, email: true } }, salonRole: true }
    })),
    safe(prisma.appointment.findMany({
      where: { salonId, ...branchFilter, OR: [{ title: term }, { customer: { name: term } }] },
      take: 5,
      orderBy: { startAt: "desc" },
      select: { id: true, title: true, status: true, startAt: true, customer: { select: { name: true } } }
    })),
    safe(prisma.invoice.findMany({
      where: { salonId, ...branchFilter, OR: [{ invoiceNumber: term }, { customer: { name: term } }] },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, invoiceNumber: true, total: true, status: true, customer: { select: { name: true } } }
    })),
    safe(prisma.membershipPlan.findMany({
      where: { salonId, isActive: true, ...branchFilter, name: term },
      take: 3,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, price: true, validityDays: true }
    })),
    safe(prisma.package.findMany({
      where: { salonId, isActive: true, ...branchFilter, name: term },
      take: 3,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, price: true }
    }))
  ]);

  const results = [];
  customers.forEach(c => results.push({ id: c.id, title: c.name, subtitle: [c.phone, c.email].filter(Boolean).join(" | ") || "Guest", module: "CRM", icon: "user", to: `/admin/customers?q=${encodeURIComponent(c.name)}` }));
  services.forEach(s => results.push({ id: s.id, title: s.name, subtitle: `${s.category?.name || "Service"} — ₹${s.price}`, module: "Services", icon: "scissors", to: `/admin/services?q=${encodeURIComponent(s.name)}` }));
  products.forEach(p => results.push({ id: p.id, title: p.name, subtitle: `SKU: ${p.sku || "N/A"} — ₹${p.sellingPrice} — Stock: ${p.currentStock}`, module: "Inventory", icon: "package", to: `/admin/inventory?q=${encodeURIComponent(p.name)}` }));
  staff.forEach(u => results.push({ id: u.id, title: u.user?.name || "Staff", subtitle: `${u.salonRole || "Staff member"}${u.user?.email ? " — " + u.user.email : ""}`, module: "Staff", icon: "users", to: `/admin/users?q=${encodeURIComponent(u.user?.name || "")}` }));
  appointments.forEach(a => results.push({ id: a.id, title: a.title || a.customer?.name || "Appointment", subtitle: `${a.status} — ${new Date(a.startAt).toLocaleDateString()} — ${a.customer?.name || ""}`, module: "Appointments", icon: "calendar", to: `/admin/appointments?q=${encodeURIComponent(a.title || a.customer?.name || "")}` }));
  invoices.forEach(inv => results.push({ id: inv.id, title: inv.invoiceNumber || "Invoice", subtitle: `${inv.customer?.name || "Walk-in"} — ₹${inv.total} (${inv.status})`, module: "Invoices", icon: "file-text", to: `/admin/invoices?q=${encodeURIComponent(inv.invoiceNumber || "")}` }));
  memberships.forEach(m => results.push({ id: m.id, title: m.name, subtitle: `₹${m.price} — ${m.validityDays} days`, module: "Memberships", icon: "award", to: `/admin/memberships?q=${encodeURIComponent(m.name)}` }));
  packages.forEach(p => results.push({ id: p.id, title: p.name, subtitle: `₹${p.price}`, module: "Packages", icon: "gift", to: `/admin/memberships?q=${encodeURIComponent(p.name)}` }));

  results.sort((a, b) => a.title.toLowerCase().indexOf(q.toLowerCase()) - b.title.toLowerCase().indexOf(q.toLowerCase()));
  res.json({ results: results.slice(0, 20) });
});

ownerRouter.get("/branches", requireSalonPermission("branches", "view"), async (req, res) => {
  const rows = await prisma.branch.findMany({
    where: { salonId: req.salonId, isActive: true },
    include: {
      _count: {
        select: { users: true, services: true, invoices: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  res.json(rows);
});

ownerRouter.get("/branches/limit-info", requireSalonPermission("branches", "view"), async (req, res) => {
  const count = await prisma.branch.count({ where: { salonId: req.salonId, isActive: true } });
  const subscription = await prisma.subscription.findFirst({
    where: { salonId: req.salonId, status: "ACTIVE" },
    include: { plan: true }
  });
  const branchLimit = subscription?.plan?.maxBranches || subscription?.plan?.limits?.maxBranches || 999;
  res.json({ count, limit: branchLimit, canAdd: count < branchLimit });
});


ownerRouter.post("/branches", requireSalonPermission("branches", "create"), validate(schemas.branch), async (req, res) => {
  try {
    res.status(201).json(await prisma.branch.create({ data: { ...req.body, email: req.body.email || null, salonId: req.salonId } }));
  } catch (err) {
    console.error("[BranchCreate]", err);
    if (err?.code === "P2002") {
      return res.status(409).json({ message: "A branch with this name already exists in your salon." });
    }
    res.status(400).json({ message: err?.message || "Could not save branch." });
  }
});
ownerRouter.patch("/branches/:id", requireSalonPermission("branches", "edit"), validate(schemas.branch), async (req, res) => {
  try {
    const row = await findScoped("branch", req.salonId, req.params.id);
    if (!row) return res.status(404).json({ message: "Branch not found" });
    res.json(await prisma.branch.update({ where: { id: req.params.id }, data: { ...req.body, email: req.body.email || null } }));
  } catch (err) {
    console.error("[BranchUpdate]", err);
    if (err?.code === "P2002") {
      return res.status(409).json({ message: "A branch with this name already exists in your salon." });
    }
    res.status(400).json({ message: err?.message || "Could not update branch." });
  }
});
ownerRouter.patch("/branches/:id/archive", requireSalonPermission("branches", "delete"), async (req, res) => {
  const row = await findScoped("branch", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Branch not found" });
  res.json(await prisma.branch.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/service-categories/export", requireSalonPermission("services", "view"), async (req, res) => {
  const { format } = req.query;
  const branchId = normalizeBranchId(req.query.branchId);
  const serviceWhere = { isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) };
  const categories = await prisma.serviceCategory.findMany({
    where: { salonId: req.salonId, isActive: true, parentId: null },
    include: {
      children: {
        where: { isActive: true },
        include: {
          services: { where: serviceWhere }
        }
      },
      services: { where: serviceWhere }
    }
  });

  const headers = ["Category", "Subcategory", "ServiceName", "Price", "DurationMin", "TaxRate", "CommissionPct"];
  const rows = [];

  for (const cat of categories) {
    for (const svc of cat.services || []) {
      rows.push([
        cat.name,
        "",
        svc.name,
        Number(svc.price || 0),
        Number(svc.durationMin || 30),
        svc.taxRate ? Number(svc.taxRate) : "",
        svc.commissionPct ? Number(svc.commissionPct) : ""
      ]);
    }
    for (const sub of cat.children || []) {
      for (const svc of sub.services || []) {
        rows.push([
          cat.name,
          sub.name,
          svc.name,
          Number(svc.price || 0),
          Number(svc.durationMin || 30),
          svc.taxRate ? Number(svc.taxRate) : "",
          svc.commissionPct ? Number(svc.commissionPct) : ""
        ]);
      }
    }
  }

  if (String(format).toLowerCase() === "xlsx" || String(format).toLowerCase() === "xls" || String(format).toLowerCase() === "excel") {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Services");
    worksheet.addRow(headers);
    rows.forEach(r => worksheet.addRow(r));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="services-export.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } else {
    const csv = buildCsv(headers, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="service-categories-export.csv"');
    res.send(csv);
  }
});

ownerRouter.get("/service-categories/test-template", requireSalonPermission("services", "view"), async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Respark ERP";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Service Test Data");

  const columns = [
    { header: "ServiceName (Mandatory)", key: "name", width: 28 },
    { header: "Category (Mandatory)", key: "category", width: 22 },
    { header: "Price (Mandatory)", key: "price", width: 18 },
    { header: "DurationMin (Mandatory)", key: "durationMin", width: 24 },
    { header: "Subcategory (Optional)", key: "subcategory", width: 24 },
    { header: "Gender (Optional)", key: "gender", width: 18 },
    { header: "TaxRate (Optional)", key: "taxRate", width: 18 },
    { header: "CommissionPct (Optional)", key: "commissionPct", width: 22 },
    { header: "Description (Optional)", key: "description", width: 35 },
    { header: "OnlineBooking (Optional)", key: "onlineBooking", width: 22 }
  ];

  worksheet.columns = columns;

  const sampleRows = [
    {
      name: "Haircut & Beard Styling",
      category: "Hair Care",
      price: 1500,
      durationMin: 45,
      subcategory: "Men's Grooming",
      gender: "MALE",
      taxRate: 0,
      commissionPct: 15,
      description: "Premium haircut with hot towel beard shaping",
      onlineBooking: "YES"
    },
    {
      name: "Keratin Smooth Treatment",
      category: "Hair Care",
      price: 8500,
      durationMin: 120,
      subcategory: "Chemical Treatments",
      gender: "FEMALE",
      taxRate: 5,
      commissionPct: 20,
      description: "Formaldehyde-free protein smoothing treatment",
      onlineBooking: "YES"
    },
    {
      name: "Hydra Deep Cleansing Facial",
      category: "Skin Care",
      price: 4500,
      durationMin: 60,
      subcategory: "Facials",
      gender: "UNISEX",
      taxRate: 0,
      commissionPct: 15,
      description: "Multi-step hydrating extraction and serum infusion",
      onlineBooking: "YES"
    },
    {
      name: "Classic Manicure & Pedicure",
      category: "Nail Care",
      price: 2800,
      durationMin: 60,
      subcategory: "Hands & Feet",
      gender: "UNISEX",
      taxRate: 0,
      commissionPct: 10,
      description: "Nail shaping, cuticle care and soothing scrub",
      onlineBooking: "YES"
    },
    {
      name: "Bridal Makeup & Styling",
      category: "Makeup & Styling",
      price: 25000,
      durationMin: 180,
      subcategory: "Bridal",
      gender: "FEMALE",
      taxRate: 10,
      commissionPct: 25,
      description: "HD bridal makeup with hair styling and draping",
      onlineBooking: "NO"
    },
    {
      name: "Swedish Full Body Massage",
      category: "Spa & Wellness",
      price: 5000,
      durationMin: 60,
      subcategory: "Massages",
      gender: "UNISEX",
      taxRate: 5,
      commissionPct: 20,
      description: "Relaxing light to medium pressure body massage",
      onlineBooking: "YES"
    },
    {
      name: "Hair Root Touch-up",
      category: "Hair Care",
      price: 3200,
      durationMin: 60,
      subcategory: "Hair Coloring",
      gender: "UNISEX",
      taxRate: 0,
      commissionPct: 12,
      description: "Ammonia-free grey coverage root touch-up",
      onlineBooking: "YES"
    }
  ];

  sampleRows.forEach(row => worksheet.addRow(row));

  const headerRow = worksheet.getRow(1);
  headerRow.height = 32;
  headerRow.eachCell((cell, colNumber) => {
    const isMandatory = colNumber <= 4;
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: isMandatory ? "FF1E3A8A" : "FF1E293B" }
    };
    cell.font = {
      name: "Calibri",
      size: 11,
      bold: true,
      color: { argb: isMandatory ? "FFFFFF00" : "FFFFFFFF" }
    };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FF94A3B8" } },
      left: { style: "thin", color: { argb: "FF94A3B8" } },
      bottom: { style: "medium", color: { argb: "FF000000" } },
      right: { style: "thin", color: { argb: "FF94A3B8" } }
    };
  });

  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  for (let r = 2; r <= sampleRows.length + 1; r++) {
    const row = worksheet.getRow(r);
    row.height = 22;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.font = { name: "Calibri", size: 10 };
      cell.alignment = { vertical: "middle", horizontal: (colNumber === 1 || colNumber === 2 || colNumber === 5) ? "left" : "center" };
      cell.border = {
        top: { style: "thin", color: { argb: "FFE2E8F0" } },
        left: { style: "thin", color: { argb: "FFE2E8F0" } },
        bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
        right: { style: "thin", color: { argb: "FFE2E8F0" } }
      };
      if (r % 2 === 1) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF8FAFC" }
        };
      }
    });
  }

  const guideSheet = workbook.addWorksheet("Instructions & Guide");
  guideSheet.views = [{ state: "frozen", ySplit: 1 }];
  guideSheet.addRow(["Field Name", "Requirement", "Accepted Values / Format", "Description"]);
  const guideHeader = guideSheet.getRow(1);
  guideHeader.height = 28;
  guideHeader.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  const guideData = [
    ["ServiceName", "MANDATORY", "Text (e.g. Haircut & Styling)", "The title or name of the service."],
    ["Category", "MANDATORY", "Text (e.g. Hair Care, Skin Care)", "Main service category (created automatically if new)."],
    ["Price", "MANDATORY", "Number (e.g. 1500)", "Selling price of the service."],
    ["DurationMin", "MANDATORY", "Number in minutes (e.g. 30, 45, 60)", "Service duration in minutes."],
    ["Subcategory", "OPTIONAL", "Text (e.g. Chemical Treatments)", "Child subcategory under the parent category."],
    ["Gender", "OPTIONAL", "UNISEX, FEMALE, MALE", "Target gender for this service. Defaults to UNISEX."],
    ["TaxRate", "OPTIONAL", "Percentage number (e.g. 0, 5, 18)", "Service tax percentage."],
    ["CommissionPct", "OPTIONAL", "Percentage number (e.g. 10, 15)", "Staff commission percentage on this service."],
    ["Description", "OPTIONAL", "Text", "Detailed description of what the service includes."],
    ["OnlineBooking", "OPTIONAL", "YES / NO", "Whether this service is visible for online catalog bookings."]
  ];

  guideData.forEach((row, i) => {
    const r = guideSheet.addRow(row);
    r.height = 22;
    const isMandatory = row[1] === "MANDATORY";
    r.getCell(1).font = { bold: true };
    r.getCell(2).font = { bold: true, color: { argb: isMandatory ? "FFDC2626" : "FF059669" } };
    r.eachCell((c) => {
      c.border = {
        top: { style: "thin", color: { argb: "FFE2E8F0" } },
        left: { style: "thin", color: { argb: "FFE2E8F0" } },
        bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
        right: { style: "thin", color: { argb: "FFE2E8F0" } }
      };
      if (i % 2 === 1) {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    });
  });

  guideSheet.columns = [
    { width: 22 },
    { width: 16 },
    { width: 35 },
    { width: 55 }
  ];

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="Services_Test_Data.xlsx"');

  await workbook.xlsx.write(res);
  res.end();
});

ownerRouter.post("/service-categories/import", requireSalonPermission("services", "create"), upload.single("file"), forceBranchForUploads, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file provided" });
  }

  const fileName = (req.file.originalname || "").toLowerCase();
  const isExcel = fileName.endsWith(".xlsx") || fileName.endsWith(".xls") || req.file.mimetype?.includes("spreadsheet") || req.file.mimetype?.includes("excel");

  let lines = [];
  if (isExcel) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    if (worksheet) {
      worksheet.eachRow((row) => {
        const rowValues = [];
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          rowValues[colNumber - 1] = cell.text ? cell.text.trim() : (cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : "");
        });
        if (rowValues.some(c => c && c.length > 0)) {
          lines.push(rowValues);
        }
      });
    }
  } else {
    const csvString = req.file.buffer.toString("utf8");
    lines = csvString.split(/\r?\n/).map(line => {
      const result = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' || char === "'") {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    }).filter(line => line.length > 0 && line.some(col => col.length > 0));
  }

  if (lines.length <= 1) {
    return res.status(400).json({ message: "Uploaded file is empty or missing headers" });
  }

  const headers = lines[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, ""));
  
  const findHeaderIdx = (...keywords) => {
    return headers.findIndex(h => keywords.some(k => h.includes(k)));
  };

  const catIdx = findHeaderIdx("category");
  const subIdx = findHeaderIdx("subcategory");
  const nameIdx = findHeaderIdx("servicename", "name", "service");
  const priceIdx = findHeaderIdx("price", "mrp", "rate");
  const durationIdx = findHeaderIdx("durationmin", "duration", "time");
  const taxIdx = findHeaderIdx("taxrate", "tax");
  const commIdx = findHeaderIdx("commissionpct", "commission");
  const genderIdx = findHeaderIdx("gender");
  const descIdx = findHeaderIdx("description", "desc");
  const onlineIdx = findHeaderIdx("onlinebooking", "online");

  if (catIdx === -1 || nameIdx === -1 || priceIdx === -1) {
    return res.status(400).json({ message: "File must contain Category, ServiceName, and Price columns" });
  }

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.length === 0) continue;

    const categoryName = row[catIdx];
    const serviceName = row[nameIdx];
    const price = Number(row[priceIdx] || 0);

    if (!categoryName || !serviceName) {
      errorCount++;
      errors.push(`Row ${i + 1}: Category name and Service name are required`);
      continue;
    }

    try {
      let parentCategory = await prisma.serviceCategory.findFirst({
        where: { salonId: req.salonId, name: categoryName, parentId: null, isActive: true }
      });

      if (!parentCategory) {
        parentCategory = await prisma.serviceCategory.create({
          data: { salonId: req.salonId, name: categoryName }
        });
      }

      const subcategoryName = subIdx !== -1 ? row[subIdx] : null;
      let targetCategoryId = parentCategory.id;

      if (subcategoryName) {
        let subCategory = await prisma.serviceCategory.findFirst({
          where: { salonId: req.salonId, name: subcategoryName, parentId: parentCategory.id, isActive: true }
        });

        if (!subCategory) {
          subCategory = await prisma.serviceCategory.create({
            data: { salonId: req.salonId, name: subcategoryName, parentId: parentCategory.id }
          });
        }
        targetCategoryId = subCategory.id;
      }

      const durationMin = durationIdx !== -1 ? Number(row[durationIdx] || 30) : 30;
      const taxRate = taxIdx !== -1 ? Number(row[taxIdx] || 0) : null;
      const commissionPct = commIdx !== -1 ? Number(row[commIdx] || 0) : null;

      const existingService = await prisma.service.findFirst({
        where: { salonId: req.salonId, name: serviceName, categoryId: targetCategoryId, isActive: true }
      });

      if (existingService) {
        await prisma.service.update({
          where: { id: existingService.id },
          data: {
            price,
            durationMin,
            taxRate,
            commissionPct
          }
        });
      } else {
        await prisma.service.create({
          data: {
            salonId: req.salonId,
            categoryId: targetCategoryId,
            name: serviceName,
            price,
            durationMin,
            taxRate,
            commissionPct,
            branchId: req.body.branchId || null
          }
        });
      }
      successCount++;
    } catch (e) {
      errorCount++;
      errors.push(`Row ${i + 1}: ${e.message}`);
    }
  }

  res.json({
    message: `Import completed: ${successCount} processed successfully, ${errorCount} errors.`,
    successCount,
    errorCount,
    errors
  });
});

ownerRouter.get("/service-categories", requireSalonPermission("services", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const svcWhere = { isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) };
  const catWhere = { salonId: req.salonId, isActive: true, parentId: null, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) };
  const svcInclude = { consumables: { include: { product: true } } };
  res.json(await prisma.serviceCategory.findMany({ where: catWhere, include: { children: { where: { isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) }, include: { services: { where: svcWhere, include: svcInclude } } }, services: { where: svcWhere, include: svcInclude }, }, orderBy: { createdAt: "desc" } }));
});
ownerRouter.post("/service-categories", requireSalonPermission("services", "create"), async (req, res) => {
  const { name, parentId } = req.body;
  const branchId = normalizeBranchId(req.body.branchId);
  if (branchId) await ensureBranch(req.salonId, branchId);
  if (!name || name.length < 2) return res.status(400).json({ message: "Name must be at least 2 characters" });
  const where = { salonId: req.salonId, name: name.trim(), isActive: true, parentId: parentId || null };
  const existing = await prisma.serviceCategory.findFirst({ where });
  if (existing) return res.status(409).json({ message: "Category with this name already exists" });
  const data = { salonId: req.salonId, name: name.trim(), branchId: branchId || null };
  if (parentId) data.parentId = parentId;
  res.status(201).json(await prisma.serviceCategory.create({ data, include: { children: true } }));
});
ownerRouter.patch("/service-categories/:id", requireSalonPermission("services", "edit"), validate(schemas.serviceCategory), async (req, res) => {
  const row = await findScoped("serviceCategory", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service category not found" });
  res.json(await prisma.serviceCategory.update({ where: { id: req.params.id }, data: req.body }));
});
ownerRouter.patch("/service-categories/:id/archive", requireSalonPermission("services", "delete"), async (req, res) => {
  const row = await findScoped("serviceCategory", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service category not found" });
  res.json(await prisma.serviceCategory.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/services", requireSalonPermission("services", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  res.json(await prisma.service.findMany({
    where: { salonId: req.salonId, isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { branch: true, category: true, consumables: { include: { product: true } }, taxes: true },
    orderBy: [{ position: "asc" }, { createdAt: "desc" }]
  }));
});
ownerRouter.post("/services", requireSalonPermission("services", "create"), validate(schemas.service), async (req, res) => {
  const branchId = normalizeBranchId(req.body.branchId);
  if (branchId) await ensureBranch(req.salonId, branchId);
  const categoryId = req.body.categoryId || null;
  const taxRows = await prisma.taxRate.findMany({ where: { salonId: req.salonId, active: true } });
  const defaultServiceTax = taxRows.find((row) => row.applicableFor?.split(",").includes("SERVICE"));
  const explicitTaxRate = req.body.taxRate != null ? toAmount(req.body.taxRate) : null;
  const { gender, consumables, taxes: serviceTaxes, ...createData } = req.body;
  const service = await prisma.service.create({
    data: {
      ...createData,
      branchId,
      categoryId,
      price: toAmount(req.body.price),
      salePrice: req.body.salePrice != null ? toAmount(req.body.salePrice) : null,
      durationMin: Number(req.body.durationMin),
      taxRate: explicitTaxRate ?? (defaultServiceTax?.rate != null ? toAmount(defaultServiceTax.rate) : null),
      commissionPct: req.body.commissionPct != null ? toAmount(req.body.commissionPct) : null,
      position: req.body.position ?? 0,
      serviceRemainderDays: req.body.serviceRemainderDays ?? 0,
      salonId: req.salonId
    }
  });
  if (Array.isArray(consumables) && consumables.length > 0) {
    await prisma.serviceConsumable.createMany({
      data: consumables.map(c => ({ serviceId: service.id, productId: c.productId, variation: c.variation || null, reqdQty: toAmount(c.reqdQty) }))
    });
  }
  if (Array.isArray(serviceTaxes) && serviceTaxes.length > 0) {
    await prisma.serviceTax.createMany({
      data: serviceTaxes.map(t => ({ serviceId: service.id, name: t.name, rate: toAmount(t.rate) }))
    });
  }
  const result = await prisma.service.findUnique({ where: { id: service.id }, include: { branch: true, category: true, consumables: { include: { product: true } }, taxes: true } });
  res.status(201).json(result);
});
ownerRouter.patch("/services/:id", requireSalonPermission("services", "edit"), validate(schemas.service), async (req, res) => {
  const row = await findScoped("service", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service not found" });
  const branchId = normalizeBranchId(req.body.branchId);
  if (branchId) await ensureBranch(req.salonId, branchId);
  const { gender, consumables, taxes: serviceTaxes, ...updateData } = req.body;
  const taxRows = await prisma.taxRate.findMany({ where: { salonId: req.salonId, active: true } });
  const defaultServiceTax = taxRows.find((taxRow) => taxRow.applicableFor?.split(",").includes("SERVICE"));
  const explicitTaxRate = req.body.taxRate != null ? toAmount(req.body.taxRate) : null;
  await prisma.service.update({
    where: { id: req.params.id },
    data: {
      ...updateData,
      branchId,
      categoryId: req.body.categoryId !== undefined ? req.body.categoryId : row.categoryId,
      price: toAmount(req.body.price),
      salePrice: req.body.salePrice !== undefined ? (req.body.salePrice != null ? toAmount(req.body.salePrice) : null) : row.salePrice,
      durationMin: Number(req.body.durationMin),
      taxRate: explicitTaxRate ?? (defaultServiceTax?.rate != null ? toAmount(defaultServiceTax.rate) : row.taxRate),
      commissionPct: req.body.commissionPct != null ? toAmount(req.body.commissionPct) : null,
      position: req.body.position ?? row.position,
      serviceRemainderDays: req.body.serviceRemainderDays ?? row.serviceRemainderDays
    }
  });
  if (Array.isArray(consumables)) {
    await prisma.serviceConsumable.deleteMany({ where: { serviceId: req.params.id } });
    if (consumables.length > 0) {
      await prisma.serviceConsumable.createMany({
        data: consumables.map(c => ({ serviceId: req.params.id, productId: c.productId, variation: c.variation || null, reqdQty: toAmount(c.reqdQty) }))
      });
    }
  }
  if (Array.isArray(serviceTaxes)) {
    await prisma.serviceTax.deleteMany({ where: { serviceId: req.params.id } });
    if (serviceTaxes.length > 0) {
      await prisma.serviceTax.createMany({
        data: serviceTaxes.map(t => ({ serviceId: req.params.id, name: t.name, rate: toAmount(t.rate) }))
      });
    }
  }
  const result = await prisma.service.findUnique({ where: { id: req.params.id }, include: { branch: true, category: true, consumables: { include: { product: true } }, taxes: true } });
  res.json(result);
});
ownerRouter.patch("/services/:id/archive", requireSalonPermission("services", "delete"), async (req, res) => {
  const row = await findScoped("service", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service not found" });
  res.json(await prisma.service.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/customers/export", requireSalonPermission("customers", "view"), async (req, res) => {
  const { format } = req.query;
  const branchId = normalizeBranchId(req.query.branchId);
  const customers = await prisma.customer.findMany({
    where: { salonId: req.salonId, ...(branchId ? { branchId } : {}) },
    orderBy: { name: "asc" }
  });
  
  const headers = ["Name", "Phone", "Email", "Gender", "DateOfBirth", "Anniversary", "Source", "Tags", "Notes", "CreatedAt"];
  const rows = customers.map(c => [
    c.name || "",
    c.phone || "",
    c.email || "",
    c.gender || "",
    c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : "",
    c.anniversary ? c.anniversary.toISOString().slice(0, 10) : "",
    c.source || "",
    Array.isArray(c.tags) ? c.tags.join("; ") : "",
    c.notes || "",
    c.createdAt ? c.createdAt.toISOString() : ""
  ]);

  if (String(format).toLowerCase() === "xls" || String(format).toLowerCase() === "xlsx" || String(format).toLowerCase() === "excel") {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Customers");
    worksheet.addRow(headers);
    rows.forEach(row => worksheet.addRow(row));
    
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=\"customers-export.xlsx\"");
    
    await workbook.xlsx.write(res);
    res.end();
  } else {
    const csv = buildCsv(headers, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"customers-export.csv\"");
    res.send(csv);
  }
});

ownerRouter.get("/customers/test-template", requireSalonPermission("customers", "view"), async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Respark ERP";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Customer Test Data");

  const columns = [
    { header: "Mobile No (Mandatory)", key: "phone", width: 22 },
    { header: "Name (Mandatory)", key: "name", width: 24 },
    { header: "Gender (Mandatory)", key: "gender", width: 20 },
    { header: "Email (Optional)", key: "email", width: 28 },
    { header: "Date Of Birth (Optional)", key: "dob", width: 22 },
    { header: "Anniversary (Optional)", key: "anniversary", width: 22 },
    { header: "Last Visited (Optional)", key: "lastVisited", width: 20 },
    { header: "Total Orders (Optional)", key: "totalOrders", width: 18 },
    { header: "Total Purchase Amount (Optional)", key: "totalPurchase", width: 26 },
    { header: "Average Purchase Amount (Optional)", key: "averagePurchase", width: 26 },
    { header: "Online Visits (Optional)", key: "onlineVisits", width: 18 },
    { header: "Loyalty Points (Optional)", key: "loyalty", width: 20 },
    { header: "Referral Code (Optional)", key: "referralCode", width: 20 },
    { header: "Advance (Optional)", key: "advance", width: 16 },
    { header: "Balance (Optional)", key: "balance", width: 16 },
    { header: "Membership Count (Optional)", key: "membershipCount", width: 24 },
    { header: "Package Count (Optional)", key: "packageCount", width: 22 },
    { header: "Source (Optional)", key: "source", width: 20 },
    { header: "GST Number (Optional)", key: "gst", width: 22 },
    { header: "Notes (Optional)", key: "notes", width: 35 },
    { header: "Tags (Optional)", key: "tags", width: 24 }
  ];

  worksheet.columns = columns;

  const sampleRows = [
    {
      phone: "92397146866",
      name: "Sadia Iqbal",
      gender: "Female",
      email: "sadia.iqbal@example.com",
      dob: "1995-04-12",
      anniversary: "2020-11-20",
      lastVisited: "2026-03-18",
      totalOrders: 3,
      totalPurchase: 4500,
      averagePurchase: 1500,
      onlineVisits: 1,
      loyalty: 150,
      referralCode: "SADIA6866",
      advance: 0,
      balance: 0,
      membershipCount: 0,
      packageCount: 0,
      source: "Walk-in",
      gst: "",
      notes: "Prefers organic hair spa products",
      tags: "Regular; VIP"
    },
    {
      phone: "92394424948",
      name: "Hamza Shah",
      gender: "Male",
      email: "hamza.shah@example.com",
      dob: "1990-08-25",
      anniversary: "",
      lastVisited: "2026-03-15",
      totalOrders: 5,
      totalPurchase: 12500,
      averagePurchase: 2500,
      onlineVisits: 2,
      loyalty: 350,
      referralCode: "HAMZA4948",
      advance: 500,
      balance: 0,
      membershipCount: 1,
      packageCount: 1,
      source: "Instagram",
      gst: "",
      notes: "Beard grooming and hair cut regular",
      tags: "Member; Premium"
    },
    {
      phone: "92320032700",
      name: "Zoya Malik",
      gender: "Female",
      email: "zoya.malik@example.com",
      dob: "1998-01-30",
      anniversary: "",
      lastVisited: "2026-03-10",
      totalOrders: 8,
      totalPurchase: 22000,
      averagePurchase: 2750,
      onlineVisits: 4,
      loyalty: 600,
      referralCode: "ZOYA2700",
      advance: 1000,
      balance: 0,
      membershipCount: 1,
      packageCount: 2,
      source: "Referral",
      gst: "",
      notes: "Allergic to ammonia hair dye",
      tags: "Gold Member; High Value"
    },
    {
      phone: "92330292304",
      name: "Fahad Raza",
      gender: "Male",
      email: "fahad.raza@example.com",
      dob: "1988-12-05",
      anniversary: "2016-01-15",
      lastVisited: "2026-02-28",
      totalOrders: 1,
      totalPurchase: 1800,
      averagePurchase: 1800,
      onlineVisits: 0,
      loyalty: 50,
      referralCode: "FAHAD2304",
      advance: 0,
      balance: 200,
      membershipCount: 0,
      packageCount: 0,
      source: "Google Search",
      gst: "",
      notes: "Evening appointments only",
      tags: "New Customer"
    },
    {
      phone: "92316918941",
      name: "Nida Hussain",
      gender: "Female",
      email: "nida.h@example.com",
      dob: "1993-07-19",
      anniversary: "",
      lastVisited: "2026-03-01",
      totalOrders: 2,
      totalPurchase: 3200,
      averagePurchase: 1600,
      onlineVisits: 1,
      loyalty: 100,
      referralCode: "NIDA8941",
      advance: 0,
      balance: 0,
      membershipCount: 0,
      packageCount: 0,
      source: "Walk-in",
      gst: "",
      notes: "Prefers weekend slots",
      tags: "Regular"
    },
    {
      phone: "92355747179",
      name: "Kamran Ali",
      gender: "Male",
      email: "kamran.ali@example.com",
      dob: "1991-09-14",
      anniversary: "2019-04-05",
      lastVisited: "2026-03-12",
      totalOrders: 4,
      totalPurchase: 8900,
      averagePurchase: 2225,
      onlineVisits: 0,
      loyalty: 220,
      referralCode: "KAMRAN7179",
      advance: 0,
      balance: 0,
      membershipCount: 0,
      packageCount: 1,
      source: "Facebook",
      gst: "",
      notes: "Skin treatment routine",
      tags: "Regular; Package Holder"
    },
    {
      phone: "92358594452",
      name: "Hira Smith",
      gender: "Female",
      email: "hira.smith@example.com",
      dob: "1996-03-22",
      anniversary: "",
      lastVisited: "2026-03-16",
      totalOrders: 6,
      totalPurchase: 15400,
      averagePurchase: 2566,
      onlineVisits: 3,
      loyalty: 450,
      referralCode: "HIRA4452",
      advance: 0,
      balance: 0,
      membershipCount: 1,
      packageCount: 0,
      source: "Referral",
      gst: "",
      notes: "Prefers Senior Stylist",
      tags: "VIP; Platinum"
    },
    {
      phone: "92329807676",
      name: "Ibrahim Ahmed",
      gender: "Male",
      email: "ibrahim.ahmed@example.com",
      dob: "1985-11-11",
      anniversary: "2012-12-12",
      lastVisited: "2026-03-05",
      totalOrders: 2,
      totalPurchase: 4000,
      averagePurchase: 2000,
      onlineVisits: 0,
      loyalty: 80,
      referralCode: "IBRAHIM7676",
      advance: 0,
      balance: 0,
      membershipCount: 0,
      packageCount: 0,
      source: "Walk-in",
      gst: "",
      notes: "Monthly haircut",
      tags: "Regular"
    }
  ];

  sampleRows.forEach(row => worksheet.addRow(row));

  const headerRow = worksheet.getRow(1);
  headerRow.height = 32;
  headerRow.eachCell((cell, colNumber) => {
    const isMandatory = colNumber <= 3;
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: isMandatory ? "FF1E3A8A" : "FF1E293B" }
    };
    cell.font = {
      name: "Calibri",
      size: 11,
      bold: true,
      color: { argb: isMandatory ? "FFFFFF00" : "FFFFFFFF" }
    };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FF94A3B8" } },
      left: { style: "thin", color: { argb: "FF94A3B8" } },
      bottom: { style: "medium", color: { argb: "FF000000" } },
      right: { style: "thin", color: { argb: "FF94A3B8" } }
    };
  });

  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  for (let r = 2; r <= sampleRows.length + 1; r++) {
    const row = worksheet.getRow(r);
    row.height = 22;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.font = { name: "Calibri", size: 10 };
      cell.alignment = { vertical: "middle", horizontal: colNumber <= 3 ? "left" : "center" };
      cell.border = {
        top: { style: "thin", color: { argb: "FFE2E8F0" } },
        left: { style: "thin", color: { argb: "FFE2E8F0" } },
        bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
        right: { style: "thin", color: { argb: "FFE2E8F0" } }
      };
      if (r % 2 === 1) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF8FAFC" }
        };
      }
    });
  }

  const guideSheet = workbook.addWorksheet("Instructions & Guide");
  guideSheet.views = [{ state: "frozen", ySplit: 1 }];
  guideSheet.addRow(["Field Name", "Requirement", "Accepted Values / Format", "Description"]);
  const guideHeader = guideSheet.getRow(1);
  guideHeader.height = 28;
  guideHeader.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  const guideData = [
    ["Mobile No", "MANDATORY", "Numbers (e.g. 92397146866 or 03001234567)", "Unique phone number for customer identification."],
    ["Name", "MANDATORY", "Text (e.g. Sadia Iqbal)", "Full name of the customer."],
    ["Gender", "MANDATORY", "Male / Female / Other", "Gender of the customer."],
    ["Email", "OPTIONAL", "Valid email (e.g. user@example.com)", "Email address for notifications and billing."],
    ["Date Of Birth", "OPTIONAL", "YYYY-MM-DD (e.g. 1995-04-12)", "Used for birthday wishes and birthday discounts."],
    ["Anniversary", "OPTIONAL", "YYYY-MM-DD (e.g. 2020-11-20)", "Used for anniversary discounts and offers."],
    ["Last Visited", "OPTIONAL", "YYYY-MM-DD (e.g. 2026-03-18)", "Date of most recent appointment or invoice."],
    ["Total Orders", "OPTIONAL", "Number (e.g. 3)", "Total invoices/orders count."],
    ["Total Purchase Amount", "OPTIONAL", "Number (e.g. 4500)", "Total amount spent by the customer."],
    ["Average Purchase Amount", "OPTIONAL", "Number (e.g. 1500)", "Average spend per visit."],
    ["Online Visits", "OPTIONAL", "Number (e.g. 1)", "Count of catalog / web bookings."],
    ["Loyalty Points", "OPTIONAL", "Number (e.g. 150)", "Current loyalty points balance."],
    ["Referral Code", "OPTIONAL", "Text (e.g. SADIA6866)", "Customer's unique referral code."],
    ["Advance", "OPTIONAL", "Number (e.g. 500)", "Advance deposit currently held."],
    ["Balance", "OPTIONAL", "Number (e.g. 200)", "Outstanding balance amount."],
    ["Membership Count", "OPTIONAL", "Number (e.g. 1)", "Number of active memberships."],
    ["Package Count", "OPTIONAL", "Number (e.g. 1)", "Number of active packages."],
    ["Source", "OPTIONAL", "Walk-in, Instagram, Google, Referral, Facebook", "How the customer found your salon."],
    ["GST Number", "OPTIONAL", "Text", "Tax identification number if corporate / business."],
    ["Notes", "OPTIONAL", "Text", "Any customer preferences, allergies, skin notes."],
    ["Tags", "OPTIONAL", "Semicolon separated (e.g. VIP; Regular)", "Custom labels for CRM segmentation."]
  ];

  guideData.forEach((row, i) => {
    const r = guideSheet.addRow(row);
    r.height = 22;
    const isMandatory = row[1] === "MANDATORY";
    r.getCell(1).font = { bold: true };
    r.getCell(2).font = { bold: true, color: { argb: isMandatory ? "FFDC2626" : "FF059669" } };
    r.eachCell((c) => {
      c.border = {
        top: { style: "thin", color: { argb: "FFE2E8F0" } },
        left: { style: "thin", color: { argb: "FFE2E8F0" } },
        bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
        right: { style: "thin", color: { argb: "FFE2E8F0" } }
      };
      if (i % 2 === 1) {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    });
  });

  guideSheet.columns = [
    { width: 22 },
    { width: 16 },
    { width: 35 },
    { width: 55 }
  ];

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="Customers_Test_Data.xlsx"');

  await workbook.xlsx.write(res);
  res.end();
});

ownerRouter.post("/customers/import", requireSalonPermission("customers", "create"), upload.single("file"), forceBranchForUploads, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file provided" });
  }

  const fileName = (req.file.originalname || "").toLowerCase();
  const isExcel = fileName.endsWith(".xlsx") || fileName.endsWith(".xls") || req.file.mimetype?.includes("spreadsheet") || req.file.mimetype?.includes("excel");

  let lines = [];
  if (isExcel) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    if (worksheet) {
      worksheet.eachRow((row) => {
        const rowValues = [];
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          rowValues[colNumber - 1] = cell.text ? cell.text.trim() : (cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : "");
        });
        if (rowValues.some(c => c && c.length > 0)) {
          lines.push(rowValues);
        }
      });
    }
  } else {
    const csvString = req.file.buffer.toString("utf8");
    lines = csvString.split(/\r?\n/).map(line => {
      const result = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' || char === "'") {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    }).filter(line => line.length > 0 && line.some(col => col.length > 0));
  }

  if (lines.length <= 1) {
    return res.status(400).json({ message: "Uploaded file is empty or missing headers" });
  }

  const headers = lines[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, ""));
  
  const findHeaderIdx = (...keywords) => {
    return headers.findIndex(h => keywords.some(k => h.includes(k)));
  };

  const nameIdx = findHeaderIdx("name");
  const phoneIdx = findHeaderIdx("phone", "mobileno", "mobile");
  const emailIdx = findHeaderIdx("email");
  const genderIdx = findHeaderIdx("gender");
  const dobIdx = findHeaderIdx("dateofbirth", "dob", "birth");
  const anniversaryIdx = findHeaderIdx("anniversary");
  const sourceIdx = findHeaderIdx("source");
  const tagsIdx = findHeaderIdx("tags");
  const notesIdx = findHeaderIdx("notes");

  if (phoneIdx === -1) {
    return res.status(400).json({ message: "File must contain a 'Phone' or 'Mobile No' column" });
  }

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.length === 0) continue;
    
    const phone = row[phoneIdx];
    if (!phone) {
      errorCount++;
      errors.push(`Row ${i + 1}: Phone number is missing`);
      continue;
    }

    const name = nameIdx !== -1 ? (row[nameIdx] || "Guest") : "Guest";
    const email = emailIdx !== -1 ? row[emailIdx] : null;
    const gender = genderIdx !== -1 ? String(row[genderIdx]).toLowerCase() : null;
    const dateOfBirth = dobIdx !== -1 && row[dobIdx] ? new Date(row[dobIdx]) : null;
    const anniversary = anniversaryIdx !== -1 && row[anniversaryIdx] ? new Date(row[anniversaryIdx]) : null;
    const source = sourceIdx !== -1 ? row[sourceIdx] : null;
    const notes = notesIdx !== -1 ? row[notesIdx] : null;
    
    let tags = [];
    if (tagsIdx !== -1 && row[tagsIdx]) {
      tags = row[tagsIdx].split(";").map(t => t.trim()).filter(Boolean);
    }

    try {
      const duplicate = await prisma.customer.findFirst({
        where: { salonId: req.salonId, phone }
      });

      if (duplicate) {
        await prisma.customer.update({
          where: { id: duplicate.id },
          data: {
            name,
            email: email || duplicate.email,
            gender: gender || duplicate.gender,
            dateOfBirth: (dateOfBirth && !isNaN(dateOfBirth.getTime())) ? dateOfBirth : duplicate.dateOfBirth,
            anniversary: (anniversary && !isNaN(anniversary.getTime())) ? anniversary : duplicate.anniversary,
            source: source || duplicate.source,
            tags: tags.length > 0 ? Array.from(new Set([...duplicate.tags, ...tags])) : duplicate.tags,
            notes: notes || duplicate.notes
          }
        });
      } else {
        await prisma.customer.create({
          data: {
            salonId: req.salonId,
            name,
            phone,
            email,
            gender,
            dateOfBirth: (dateOfBirth && !isNaN(dateOfBirth.getTime())) ? dateOfBirth : null,
            anniversary: (anniversary && !isNaN(anniversary.getTime())) ? anniversary : null,
            source,
            tags,
            notes
          }
        });
      }
      successCount++;
    } catch (e) {
      errorCount++;
      errors.push(`Row ${i + 1}: ${e.message}`);
    }
  }

  res.json({
    message: `Import completed: ${successCount} processed successfully, ${errorCount} errors.`,
    successCount,
    errorCount,
    errors
  });
});

ownerRouter.get("/customers", requireSalonPermission("customers", "view"), async (req, res) => {
  const query = String(req.query.q || "").trim();
  const filter = String(req.query.filter || "").trim();
  const branchId = normalizeBranchId(req.query.branchId);
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const take = Math.min(Number(req.query.take) || 100, 500);
  const skip = Number(req.query.skip) || 0;
  const where = {
    salonId: req.salonId,
    ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
    ...(query ? {
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { phone: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
        { source: { contains: query, mode: "insensitive" } }
      ]
    } : {}),
    ...(filter === "high_spender" ? { totalSpend: { gte: 10000 } } : {}),
    ...(filter === "lost_customer" ? { OR: [{ lastVisitAt: null }, { lastVisitAt: { lte: ninetyDaysAgo } }] } : {}),
    ...(filter === "active_membership" ? { memberships: { some: { status: "ACTIVE", endsAt: { gte: now } } } } : {}),
    ...(filter === "active_package" ? { packages: { some: { status: "ACTIVE", endsAt: { gte: now } } } } : {})
  };
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      include: {
        preferredStaff: { include: { user: true } },
        invoices: {
          select: { id: true, balanceAmount: true }
        },
        timelineEntries: {
          where: { eventType: "ADVANCE_PAYMENT" },
          select: { details: true }
        },
        _count: {
          select: {
            invoices: true,
            memberships: true,
            packages: true
          }
        }
      },
      orderBy: { createdAt: "desc" },
      take,
      skip
    }),
    prisma.customer.count({ where })
  ]);

  // Batch fetch advance-related data: invoice items with type=ADVANCE (to identify advance-deposit invoices)
  // and payments with mode=ADVANCE (to compute used advance per customer)
  const allCustomerIds = rows.map((row) => row.id);
  const allInvoiceIds = rows.flatMap((row) => (row.invoices || []).map((inv) => inv.id));
  const [advanceInvoiceItems, usedAdvancePayments] = await Promise.all([
    prisma.invoiceItem.findMany({
      where: { itemType: "ADVANCE", invoiceId: { in: allInvoiceIds } },
      select: { invoiceId: true }
    }),
    prisma.payment.findMany({
      where: { salonId: req.salonId, mode: "ADVANCE" },
      select: { invoiceId: true, amount: true, invoice: { select: { customerId: true } } }
    })
  ]);
  const advanceInvoiceIds = new Set(advanceInvoiceItems.map((i) => i.invoiceId));
  // Compute used advance per customer (only count payments on non-advance-deposit invoices)
  const usedAdvanceByCustomer = new Map();
  usedAdvancePayments.forEach((p) => {
    if (!p.invoice?.customerId) return;
    if (advanceInvoiceIds.has(p.invoiceId)) return; // skip payments ON the advance deposit invoice itself
    const cid = p.invoice.customerId;
    usedAdvanceByCustomer.set(cid, (usedAdvanceByCustomer.get(cid) || 0) + Number(p.amount || 0));
  });

  const filteredRows = rows.filter((row) => {
    if (filter === "birthday_month") return row.dateOfBirth ? new Date(row.dateOfBirth).getMonth() === now.getMonth() : false;
    if (filter === "anniversary_month") return row.anniversary ? new Date(row.anniversary).getMonth() === now.getMonth() : false;
    return true;
  });
  const mapped = filteredRows.map(row => {
    const balanceAmount = (row.invoices || []).reduce((sum, inv) => sum + Number(inv.balanceAmount || 0), 0);
    const totalAdvance = (row.timelineEntries || []).reduce((sum, entry) => {
      try {
        const details = JSON.parse(entry.details || "{}");
        return sum + Number(details.amount || 0);
      } catch (e) {
        return sum;
      }
    }, 0);
    const usedAdvance = usedAdvanceByCustomer.get(row.id) || 0;
    // Show AVAILABLE advance (consistent with POS, customer detail, and CRM advance tab)
    const advanceAmount = Math.max(0, totalAdvance - usedAdvance);

    const namePart = (row.name || "GUEST").trim().split(" ")[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const phonePart = (row.phone || "0000").replace(/[^0-9]/g, "").slice(-4);
    const referralCode = `${namePart}${phonePart}`;

    const { invoices, timelineEntries, ...rest } = row;
    return {
      ...rest,
      totalOrders: row._count?.invoices || 0,
      membershipCount: row._count?.memberships || 0,
      packageCount: row._count?.packages || 0,
      advanceAmount,
      balanceAmount,
      referralCode
    };
  });
  res.json({ data: mapped, total });
});
ownerRouter.post("/customers", requireSalonPermission("customers", "create"), validate(schemas.customer), async (req, res) => {
  const duplicate = await prisma.customer.findFirst({ where: { salonId: req.salonId, phone: req.body.phone } });
  if (duplicate) return res.status(400).json({ message: "Customer with this phone already exists in this salon" });
  if (req.body.branchId) await ensureBranch(req.salonId, req.body.branchId);
  const customer = await prisma.customer.create({
    data: buildCustomerData(req.body, req.salonId)
  });

  res.status(201).json(customer);

  // ── Fire-and-forget: referral code notification + email ──────────────────────
  (async () => {
    try {
      const setting = await prisma.salonSetting.findFirst({
        where: { salonId: req.salonId, branchId: null }
      });
      const toggles = setting?.advancedSettings?.notificationSettings?.toggles || {};
      const emailEnabled = setting?.advancedSettings?.notificationSettings?.emailEnabled !== false;

      if (toggles.referralCodeSMS !== false) {
        const namePart = (customer.name || "GUEST").trim().split(" ")[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        const phonePart = (customer.phone || "0000").replace(/[^0-9]/g, "").slice(-4);
        const referralCode = `${namePart}${phonePart}`;

        await prisma.customerNotification.create({
          data: {
            salonId: req.salonId,
            customerId: customer.id,
            title: "🎁 Your Referral Code",
            message: `Share your referral code "${referralCode}" with friends! Both of you get rewarded when they visit us.`
          }
        }).catch(() => {});

        if (emailEnabled && customer.email) {
          const { attemptCustomerTemplateEmail } = await import("../../lib/emailNotifications.js");
          await attemptCustomerTemplateEmail({
            salonId: req.salonId,
            toEmail: customer.email,
            templateType: "referral_code_sms",
            context: { customerId: customer.id, referralCode }
          }).catch(() => {});
        }
      }
    } catch (referralErr) {
      console.error("[owner/customers] Referral code notification error (non-blocking):", referralErr.message);
    }
  })();
});
ownerRouter.patch("/customers/:id", requireSalonPermission("customers", "edit"), validate(schemas.customerPatch), updateCustomerHandler);
ownerRouter.put("/customers/:id", requireSalonPermission("customers", "edit"), validate(schemas.customerPatch), updateCustomerHandler);
ownerRouter.get("/customers/:id", requireSalonPermission("customers", "view"), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, salonId: req.salonId },
    include: {
      invoices: {
        include: { items: true, payments: true, branch: true },
        orderBy: { createdAt: "desc" }
      },
      memberships: {
        include: { membershipPlan: true },
        orderBy: { createdAt: "desc" }
      },
      packages: {
        include: {
          package: {
            include: {
              services: {
                include: {
                  service: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: "desc" }
      }
    }
  });
  if (!customer) return res.status(404).json({ message: "Customer not found" });

  const balanceAmount = customer.invoices.reduce((sum, inv) => sum + Number(inv.balanceAmount || 0), 0);
  const [advanceTimelineEntries, followUpEntries, staffDirectory, advanceInvoiceItems, usedAdvancePayments] = await Promise.all([
    prisma.customerTimeline.findMany({
      where: { customerId: req.params.id, eventType: "ADVANCE_PAYMENT" }
    }),
    prisma.customerTimeline.findMany({
      where: { customerId: req.params.id, eventType: "FOLLOW_UP" },
      orderBy: { createdAt: "desc" }
    }),
    prisma.userSalon.findMany({
      where: { salonId: req.salonId, isArchived: false },
      include: { user: true }
    }),
    prisma.invoiceItem.findMany({ where: { itemType: "ADVANCE", invoice: { salonId: req.salonId } }, select: { invoiceId: true } }),
    prisma.payment.findMany({
      where: { salonId: req.salonId, mode: "ADVANCE" },
      select: { invoice: { select: { customerId: true } }, amount: true }
    })
  ]);
  const staffNameMap = new Map(staffDirectory.map((row) => [row.id, row.user?.name || row.user?.email || row.id]));
  const followUps = followUpEntries.map((entry) => {
    try {
      const details = JSON.parse(entry.details || "{}");
      const staffName = details.staffName || (details.staffUserId ? staffNameMap.get(details.staffUserId) : "");
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        eventType: entry.eventType,
        title: entry.title,
        message: details.message || entry.title,
        note: details.message || entry.title,
        date: details.date || "",
        time: details.time || "",
        type: details.type || "call",
        status: details.status || "SCHEDULED",
        staffUserId: details.staffUserId || "",
        staffName: staffName || "",
        scheduledFor: details.time ? `${details.date || ""}T${details.time}` : (details.date || "")
      };
    } catch (e) {
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        eventType: entry.eventType,
        title: entry.title,
        message: entry.title,
        note: entry.title,
        date: "",
        time: "",
        type: "call",
        status: "SCHEDULED",
        staffUserId: "",
        staffName: ""
      };
    }
  });
  const timelineEntries = advanceTimelineEntries;
  const totalAdvance = timelineEntries.reduce((sum, entry) => {
    try {
      const details = JSON.parse(entry.details || "{}");
      return sum + Number(details.amount || 0);
    } catch (e) {
      return sum;
    }
  }, 0);
  // Compute available advance: total advance - advance used as payment on non-advance-invoices
  // Advance deposits (itemType='ADVANCE' on the deposit invoice itself) are excluded
  const advanceInvoiceIds = new Set(advanceInvoiceItems.map(i => i.invoiceId));
  const customerInvoiceIds = new Set(customer.invoices.map(i => i.id));
  const customerUsedAdvance = usedAdvancePayments.reduce((sum, p) => {
    if (!customerInvoiceIds.has(p.invoice?.id || p.invoiceId)) return sum;
    return sum + Number(p.amount || 0);
  }, 0);
  const advanceAmount = Math.max(0, totalAdvance - customerUsedAdvance);

  const familyMembers = await prisma.customer.findMany({
    where: { salonId: req.salonId, notes: { contains: `familyMemberOf:${req.params.id}` } }
  });

  const totalOrders = customer.invoices.length;
  const namePart = (customer.name || "GUEST").trim().split(" ")[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const phonePart = (customer.phone || "0000").replace(/[^0-9]/g, "").slice(-4);
  const referralCode = `${namePart}${phonePart}`;

  // Evaluate matching CRM segments for this customer
  const setting = await prisma.salonSetting.findFirst({
    where: { salonId: req.salonId, branchId: null }
  });
  const advancedSettings = setting?.advancedSettings || {};
  const crmSegments = advancedSettings.crmSegments || [];
  const matchedSegments = [];
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  for (const segment of crmSegments) {
    if (segment.active === false) continue;
    let matched = false;
    const filterType = segment.filterType || "ALL_CUSTOMERS";

    if (filterType === "ALL_CUSTOMERS") {
      matched = true;
    } else if (filterType === "BIRTHDAY_CUSTOMERS") {
      matched = customer.dateOfBirth ? new Date(customer.dateOfBirth).getMonth() === now.getMonth() : false;
    } else if (filterType === "ANNIVERSARY_CUSTOMERS") {
      matched = customer.anniversary ? new Date(customer.anniversary).getMonth() === now.getMonth() : false;
    } else if (filterType === "LOST_CUSTOMERS") {
      matched = !customer.lastVisitAt || new Date(customer.lastVisitAt) <= ninetyDaysAgo;
    } else if (filterType === "HIGH_SPENDERS") {
      matched = Number(customer.totalSpend || 0) >= 10000;
    } else if (filterType === "MEMBERSHIP_CUSTOMERS") {
      matched = customer.memberships.some(m => m.status === "ACTIVE" && new Date(m.endsAt) >= now);
    } else if (filterType === "PACKAGE_CUSTOMERS") {
      matched = customer.packages.some(p => p.status === "ACTIVE" && new Date(p.endsAt) >= now);
    } else if (filterType === "SERVICE_BASED_CUSTOMERS") {
      const serviceId = segment.serviceId;
      if (serviceId) {
        matched = customer.invoices.some(inv =>
          (inv.items || []).some(item => item.serviceId === serviceId)
        );
      }
    }

    if (matched) {
      matchedSegments.push({
        id: segment.id,
        name: segment.name || "Unnamed Segment",
        description: segment.description || ""
      });
    }
  }

  res.json({
    ...customer,
    totalOrders,
    advanceAmount,
    balanceAmount,
    familyMembers,
    referralCode,
    followUps,
    segments: matchedSegments
  });
});

ownerRouter.delete("/customers/:id", requireSalonPermission("customers", "edit"), async (req, res) => {
  const row = await prisma.customer.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) {
    const anyCustomer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!anyCustomer) {
      return res.json({ success: true, message: "Customer already removed" });
    }
    return res.status(403).json({ message: "Unauthorized to delete customer" });
  }

  const [invoiceCount, activeMemberships, activePackages] = await Promise.all([
    prisma.invoice.count({ where: { customerId: row.id } }),
    prisma.customerMembership.count({ where: { customerId: row.id, status: "ACTIVE" } }),
    prisma.customerPackage.count({ where: { customerId: row.id, status: "ACTIVE" } })
  ]);

  if (invoiceCount > 0) {
    return res.status(400).json({ message: `Cannot delete customer with ${invoiceCount} invoice(s). Deactivate or archive instead.` });
  }
  if (activeMemberships > 0) {
    return res.status(400).json({ message: `Cannot delete customer with ${activeMemberships} active membership(s).` });
  }
  if (activePackages > 0) {
    return res.status(400).json({ message: `Cannot delete customer with ${activePackages} active package(s).` });
  }

  const cid = row.id;

  // 1. Customer timelines, notifications, feedback
  await prisma.customerTimeline.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.customerNotification.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.customerFeedback.deleteMany({ where: { customerId: cid } }).catch(() => {});

  // 2. Loyalty & wallet
  await prisma.loyaltyTransaction.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.walletTransaction.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { customerId: cid } }).catch(() => {});

  // 3. Coupons & gift cards
  await prisma.couponRedemption.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.giftCardRedemption.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.customerCoupon.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.coupon.updateMany({ where: { partnerCustomerId: cid }, data: { partnerCustomerId: null } }).catch(() => {});
  await prisma.giftCard.updateMany({ where: { issuedToCustomerId: cid }, data: { issuedToCustomerId: null } }).catch(() => {});

  // 4. Marketing, whatsapp, enquiries
  await prisma.campaignConversion.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.whatsAppLog.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.referralCode.updateMany({ where: { refereeId: cid }, data: { refereeId: null } }).catch(() => {});
  await prisma.referralCode.deleteMany({ where: { customerId: cid } }).catch(() => {});
  await prisma.enquiry.updateMany({ where: { convertedCustomerId: cid }, data: { convertedCustomerId: null } }).catch(() => {});

  // 5. Memberships & packages (including usages)
  const mems = await prisma.customerMembership.findMany({ where: { customerId: cid }, select: { id: true } });
  if (mems.length) {
    const memIds = mems.map(m => m.id);
    await prisma.membershipUsage.deleteMany({ where: { customerMembershipId: { in: memIds } } }).catch(() => {});
    await prisma.customerMembership.deleteMany({ where: { id: { in: memIds } } }).catch(() => {});
  }

  const pkgs = await prisma.customerPackage.findMany({ where: { customerId: cid }, select: { id: true } });
  if (pkgs.length) {
    const pkgIds = pkgs.map(p => p.id);
    await prisma.packageUsage.deleteMany({ where: { customerPackageId: { in: pkgIds } } }).catch(() => {});
    await prisma.customerPackage.deleteMany({ where: { id: { in: pkgIds } } }).catch(() => {});
  }

  // 6. Appointments & appointment details
  const appts = await prisma.appointment.findMany({ where: { customerId: cid }, select: { id: true } });
  if (appts.length) {
    const apptIds = appts.map(a => a.id);
    const apptServices = await prisma.appointmentService.findMany({ where: { appointmentId: { in: apptIds } }, select: { id: true } });
    if (apptServices.length) {
      const apptServiceIds = apptServices.map(s => s.id);
      await prisma.appointmentServiceStaff.deleteMany({ where: { appointmentServiceId: { in: apptServiceIds } } }).catch(() => {});
    }
    await prisma.appointmentService.deleteMany({ where: { appointmentId: { in: apptIds } } }).catch(() => {});
    await prisma.appointmentLog.deleteMany({ where: { appointmentId: { in: apptIds } } }).catch(() => {});
    await prisma.appointment.deleteMany({ where: { id: { in: apptIds } } }).catch(() => {});
  }

  // 7. Orders & affiliate
  await prisma.onlineOrder.updateMany({ where: { customerId: cid }, data: { customerId: null } }).catch(() => {});
  await prisma.creditPayoutRequest.deleteMany({ where: { partnerId: cid } }).catch(() => {});
  await prisma.affiliateCreditWallet.deleteMany({ where: { partnerId: cid } }).catch(() => {});

  // 8. Delete customer
  await prisma.customer.delete({ where: { id: cid } });

  await createAuditLog({
    salonId: req.salonId,
    actorUserId: req.user?.id || "",
    actorMembershipId: req.membershipId || "",
    module: "CUSTOMERS",
    action: "CUSTOMER_DELETED",
    entityType: "Customer",
    entityId: row.id,
    reference: row.phone || row.name,
    summary: `Customer ${row.name || row.phone} deleted`
  }).catch(() => {});

  res.json({ message: "Customer deleted" });
});

ownerRouter.post("/follow-ups", requireSalonPermission("customers", "edit"), validate(schemas.customerFollowUp), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.body.customerId, salonId: req.salonId }
  });
  if (!customer) return res.status(404).json({ message: "Customer not found" });

  const staffUser = await prisma.userSalon.findFirst({
    where: { id: req.body.staffUserId, salonId: req.salonId, isArchived: false },
    include: { user: true }
  });
  if (!staffUser) return res.status(400).json({ message: "Assigned staff not found for this salon" });

  const title = `Follow-up scheduled (${String(req.body.type || "call").toUpperCase()})`;
  const scheduledAt = req.body.date && req.body.time
    ? `${req.body.date}T${req.body.time}`
    : req.body.date || null;
  const details = {
    date: req.body.date,
    time: req.body.time || "",
    message: req.body.message,
    type: req.body.type,
    status: "SCHEDULED",
    emailSent: false,
    scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    staffUserId: staffUser.id,
    staffName: staffUser.user?.name || staffUser.user?.email || staffUser.id
  };

  const timeline = await prisma.customerTimeline.create({
    data: {
      customerId: customer.id,
      eventType: "FOLLOW_UP",
      title,
      details: JSON.stringify(details),
      referenceId: customer.id
    }
  });

  await createAuditLog({
    salonId: req.salonId,
    actorUserId: req.user.userId,
    actorMembershipId: req.user.membershipId,
    module: "CRM",
    action: "FOLLOW_UP_CREATED",
    entityType: "CustomerTimeline",
    entityId: timeline.id,
    summary: `Follow-up scheduled for ${customer.name || customer.phone || customer.id}`
  });

  res.status(201).json({
    ...timeline,
    ...details
  });
});

ownerRouter.get("/users", requireSalonPermission("staff", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const includeArchived = req.query.includeArchived === "true";
  res.json(await prisma.userSalon.findMany({
    where: { salonId: req.salonId, ...(includeArchived ? {} : { isArchived: false }), ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { user: true, branch: true, customRole: true, shift: true, serviceAssignments: { include: { service: true } } },
    orderBy: { id: "desc" }
  }));
});
ownerRouter.get("/staff-users", requireSalonPermission("staff", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const rows = await prisma.userSalon.findMany({
    where: { salonId: req.salonId, isArchived: false, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { user: true, branch: true, customRole: true, shift: true, serviceAssignments: { include: { service: true } } },
    orderBy: { id: "desc" }
  });
  res.json(rows.map((row) => ({
    ...row,
    name: row.user?.name || "",
    email: row.user?.email || "",
    phone: row.user?.phone || row.phone || ""
  })));
});
ownerRouter.get("/custom-roles", requireSalonPermission("staff", "view"), async (req, res) => {
  res.json(await prisma.customRole.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } }));
});
const stripDeletePerms = (perms) => {
  if (!perms || typeof perms !== "object") return perms;
  const out = {};
  for (const [k, v] of Object.entries(perms)) { out[k] = Array.isArray(v) ? v.filter((a) => a !== "delete") : v; }
  return out;
};
ownerRouter.post("/custom-roles", requireSalonPermission("staff", "create"), validate(schemas.customRole), async (req, res) => {
  const existing = await prisma.customRole.findFirst({ where: { salonId: req.salonId, name: req.body.name } });
  if (existing) return res.status(400).json({ message: "A custom role with this name already exists" });
  res.status(201).json(await prisma.customRole.create({
    data: { salonId: req.salonId, name: req.body.name, description: req.body.description || null, permissions: stripDeletePerms(req.body.permissions) }
  }));
});
ownerRouter.patch("/custom-roles/:id", requireSalonPermission("staff", "edit"), validate(schemas.customRole), async (req, res) => {
  const role = await prisma.customRole.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!role) return res.status(404).json({ message: "Custom role not found" });
  const updatedPerms = stripDeletePerms(req.body.permissions);
  const updated = await prisma.customRole.update({
    where: { id: role.id },
    data: { name: req.body.name, description: req.body.description || null, permissions: updatedPerms }
  });
  const affectedUsers = await prisma.userSalon.findMany({ where: { customRoleId: role.id, salonId: req.salonId } });
  if (affectedUsers.length) {
    const newPerms = { ...STAFF_SELF_SERVICE_DEFAULTS, ...updatedPerms };
    for (const [k, v] of Object.entries(newPerms)) { if (Array.isArray(v)) newPerms[k] = v.filter((a) => a !== "delete"); }
    await prisma.userSalon.updateMany({ where: { customRoleId: role.id, salonId: req.salonId }, data: { permissions: newPerms } });
  }
  res.json(updated);
});
ownerRouter.delete("/custom-roles/:id", requireSalonPermission("staff", "edit"), async (req, res) => {
  const role = await prisma.customRole.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!role) return res.status(404).json({ message: "Custom role not found" });
  await prisma.userSalon.updateMany({ where: { customRoleId: role.id, salonId: req.salonId }, data: { customRoleId: null, permissions: STAFF_SELF_SERVICE_DEFAULTS } });
  await prisma.customRole.delete({ where: { id: role.id } });
  res.json({ message: "Custom role deleted" });
});
ownerRouter.post("/users", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.post("/staff-users", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.patch("/users/:id", requireSalonPermission("staff", "edit"), validate(schemas.userMembershipUpdate), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  if (req.body.phone) {
    const dup = await prisma.userSalon.findFirst({ where: { salonId: req.salonId, phone: req.body.phone, NOT: { id: req.params.id }, isArchived: false } });
    if (dup) return res.status(400).json({ message: "Another staff member already uses this phone number" });
  }
  let branchId = req.body.branchId === null ? null : normalizeBranchId(req.body.branchId ?? row.branchId);
  if (!branchId) {
    const firstBranch = await prisma.branch.findFirst({ where: { salonId: req.salonId, isActive: true }, orderBy: { createdAt: "asc" } });
    if (firstBranch) branchId = firstBranch.id;
  }
  const customRoleId = req.body.customRoleId === null ? null : (req.body.customRoleId !== undefined ? req.body.customRoleId : (req.body.permissions !== undefined ? null : (row.customRoleId ?? null)));
  if (branchId) await ensureBranch(req.salonId, branchId);
  const resolvedPermissions = await resolveMembershipPermissions(req.salonId, customRoleId, req.body.permissions);
  if (Array.isArray(req.body.serviceIds) && req.body.serviceIds.length) {
    const services = await prisma.service.findMany({ where: { id: { in: req.body.serviceIds }, salonId: req.salonId, isActive: true } });
    if (services.length !== req.body.serviceIds.length) return res.status(400).json({ message: "One or more assigned services are invalid for this salon" });
    if (branchId) {
      const invalidService = services.find((s) => s.branchId && s.branchId !== branchId);
      if (invalidService) return res.status(400).json({ message: "Assigned services must belong to the selected branch or be branch-shared" });
    }
  }
  const updated = await prisma.$transaction(async (tx) => {
    const membership = await tx.userSalon.update({
      where: { id: req.params.id },
      data: {
        salonRole: req.body.salonRole ?? row.salonRole,
        branchId,
        customRoleId,
        phone: req.body.phone ?? row.phone,
        profileNote: req.body.profileNote ?? row.profileNote,
        avatarUrl: req.body.avatarUrl ?? row.avatarUrl,
        roleTitle: req.body.roleTitle ?? row.roleTitle,
        showInCatalog: req.body.showInCatalog ?? row.showInCatalog,
        attendanceEnabled: req.body.attendanceEnabled ?? row.attendanceEnabled,
        attendanceEnrollmentPhotoUrl: req.body.attendanceEnrollmentPhotoUrl !== undefined ? (req.body.attendanceEnrollmentPhotoUrl || null) : row.attendanceEnrollmentPhotoUrl,
        attendanceEnrollmentCapturedAt: req.body.attendanceEnrollmentPhotoUrl !== undefined
          ? (req.body.attendanceEnrollmentPhotoUrl ? new Date() : null)
          : row.attendanceEnrollmentCapturedAt,
        isArchived: req.body.isArchived ?? row.isArchived,
        permissions: resolvedPermissions,
        joiningDate: req.body.joiningDate !== undefined ? (req.body.joiningDate ? new Date(req.body.joiningDate) : null) : row.joiningDate,
        designation: req.body.designation !== undefined ? (req.body.designation || null) : row.designation,
        uanNumber: req.body.uanNumber !== undefined ? (req.body.uanNumber || null) : row.uanNumber,
        reportingToId: req.body.reportingToId !== undefined ? (req.body.reportingToId || null) : row.reportingToId,
        workingHours: req.body.workingHours !== undefined ? (req.body.workingHours || null) : row.workingHours,
        bankName: req.body.bankName !== undefined ? (req.body.bankName || null) : row.bankName,
        bankBranch: req.body.bankBranch !== undefined ? (req.body.bankBranch || null) : row.bankBranch,
        accountNumber: req.body.accountNumber !== undefined ? (req.body.accountNumber || null) : row.accountNumber,
        ifscCode: req.body.ifscCode !== undefined ? (req.body.ifscCode || null) : row.ifscCode
      },
      include: { user: true, branch: true, customRole: true }
    });
    if (Array.isArray(req.body.serviceIds)) {
      // Validate all service ids belong to this salon before mutating anything
      if (req.body.serviceIds.length) {
        const services = await tx.service.findMany({
          where: { id: { in: req.body.serviceIds }, salonId: req.salonId, isActive: true }
        });
        if (services.length !== req.body.serviceIds.length) {
          const error = new Error("One or more assigned services are invalid for this salon");
          error.status = 400;
          throw error;
        }
        if (branchId) {
          const invalidService = services.find((s) => s.branchId && s.branchId !== branchId);
          if (invalidService) {
            const error = new Error("Assigned services must belong to the selected branch or be branch-shared");
            error.status = 400;
            throw error;
          }
        }
      }
      // Only mutate once the validations pass; this keeps the partial-save
      // case from wiping all existing assignments before a failure.
      await tx.staffServiceAssignment.deleteMany({ where: { userSalonId: req.params.id } });
      if (req.body.serviceIds.length) {
        await tx.staffServiceAssignment.createMany({
          data: req.body.serviceIds.map((serviceId) => ({ userSalonId: req.params.id, serviceId })),
          skipDuplicates: true
        });
      }
    }
    return tx.userSalon.findUnique({
      where: { id: req.params.id },
      include: { user: true, branch: true, customRole: true, shift: true, serviceAssignments: { include: { service: true } } }
    });
  });
  res.json(updated);
});
ownerRouter.patch("/staff-users/:id", requireSalonPermission("staff", "edit"), validate(schemas.userMembershipUpdate), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "Staff mapping not found" });
  if (req.body.phone) {
    const dup = await prisma.userSalon.findFirst({ where: { salonId: req.salonId, phone: req.body.phone, NOT: { id: req.params.id }, isArchived: false } });
    if (dup) return res.status(400).json({ message: "Another staff member already uses this phone number" });
  }
  const branchId = req.body.branchId === null ? null : normalizeBranchId(req.body.branchId ?? row.branchId);
  const customRoleId = req.body.customRoleId === null ? null : (req.body.customRoleId !== undefined ? req.body.customRoleId : (req.body.permissions !== undefined ? null : (row.customRoleId ?? null)));
  if (branchId) await ensureBranch(req.salonId, branchId);
  const resolvedPermissions = await resolveMembershipPermissions(req.salonId, customRoleId, req.body.permissions);
  const updated = await prisma.userSalon.update({
    where: { id: req.params.id },
    data: {
      salonRole: req.body.salonRole ?? row.salonRole,
      branchId,
      customRoleId,
      phone: req.body.phone ?? row.phone,
      profileNote: req.body.profileNote ?? row.profileNote,
      avatarUrl: req.body.avatarUrl ?? row.avatarUrl,
      roleTitle: req.body.roleTitle ?? row.roleTitle,
      showInCatalog: req.body.showInCatalog ?? row.showInCatalog,
      attendanceEnabled: req.body.attendanceEnabled ?? row.attendanceEnabled,
      attendanceEnrollmentPhotoUrl: req.body.attendanceEnrollmentPhotoUrl !== undefined ? (req.body.attendanceEnrollmentPhotoUrl || null) : row.attendanceEnrollmentPhotoUrl,
      attendanceEnrollmentCapturedAt: req.body.attendanceEnrollmentPhotoUrl !== undefined
        ? (req.body.attendanceEnrollmentPhotoUrl ? new Date() : null)
        : row.attendanceEnrollmentCapturedAt,
      isArchived: req.body.isArchived ?? row.isArchived,
      permissions: resolvedPermissions,
      joiningDate: req.body.joiningDate !== undefined ? (req.body.joiningDate ? new Date(req.body.joiningDate) : null) : row.joiningDate,
      designation: req.body.designation !== undefined ? (req.body.designation || null) : row.designation,
      uanNumber: req.body.uanNumber !== undefined ? (req.body.uanNumber || null) : row.uanNumber,
      reportingToId: req.body.reportingToId !== undefined ? (req.body.reportingToId || null) : row.reportingToId,
      workingHours: req.body.workingHours !== undefined ? (req.body.workingHours || null) : row.workingHours,
      shiftId: req.body.shiftId !== undefined ? (req.body.shiftId || null) : row.shiftId,
      bankName: req.body.bankName !== undefined ? (req.body.bankName || null) : row.bankName,
      bankBranch: req.body.bankBranch !== undefined ? (req.body.bankBranch || null) : row.bankBranch,
      accountNumber: req.body.accountNumber !== undefined ? (req.body.accountNumber || null) : row.accountNumber,
      ifscCode: req.body.ifscCode !== undefined ? (req.body.ifscCode || null) : row.ifscCode
    }
  });
  res.json(updated);
});
ownerRouter.get("/roles-permissions", requireSalonPermission("staff", "view"), async (req, res) => {
  res.json(
    await prisma.userSalon.findMany({
      where: { salonId: req.salonId, isArchived: false },
      include: { user: { select: { id: true, name: true, email: true, isActive: true } }, branch: true, customRole: true, serviceAssignments: { include: { service: true } } },
      orderBy: { id: "desc" }
    })
  );
});
ownerRouter.post("/users/create-login", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.patch("/users/:id/status", requireSalonPermission("staff", "edit"), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { user: true } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  res.json(await prisma.user.update({ where: { id: row.userId }, data: { isActive: Boolean(req.body.isActive) } }));
});
ownerRouter.patch("/users/:id/archive", requireSalonPermission("staff", "delete"), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  res.json(await prisma.userSalon.update({ where: { id: req.params.id }, data: { isArchived: true } }));
});
ownerRouter.patch("/users/:id/unarchive", requireSalonPermission("staff", "delete"), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  res.json(await prisma.userSalon.update({ where: { id: req.params.id }, data: { isArchived: false } }));
});

ownerRouter.get("/support-tickets", requireSalonPermission("support", "view"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const status = String(req.query.status || "").trim();
  const priority = String(req.query.priority || "").trim();
  res.json(await prisma.supportTicket.findMany({
    where: {
      salonId: req.salonId,
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(q ? {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
          { category: { contains: q, mode: "insensitive" } },
          { internalNote: { contains: q, mode: "insensitive" } },
          { assignedAgentName: { contains: q, mode: "insensitive" } }
        ]
      } : {})
    },
    include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" }
  }));
});
ownerRouter.post("/support-tickets", requireSalonPermission("support", "create"), validate(schemas.supportTicket), async (req, res) => {
  const created = await prisma.$transaction(async (tx) => {
    const { attachmentUrl, ...ticketPayload } = req.body;
    const ticket = await tx.supportTicket.create({ data: { salonId: req.salonId, ...ticketPayload } });
    await tx.supportTicketEvent.create({
      data: {
        ticketId: ticket.id,
        eventType: "CREATED",
        actorName: req.user.name,
        details: "Ticket created by salon"
      }
    });
    if (req.body.description) {
      await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: "SALON",
          authorName: req.user.name,
          message: req.body.description,
          attachmentUrl: attachmentUrl || null
        }
      });
    }
    return tx.supportTicket.findUnique({
      where: { id: ticket.id },
      include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
    });
  });
  res.status(201).json(created);
});
ownerRouter.post("/support-tickets/:id/messages", requireSalonPermission("support", "create"), validate(schemas.supportTicketMessage), async (req, res) => {
  const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!ticket) return res.status(404).json({ message: "Support ticket not found" });
  if (ticket.status === "CLOSED") return res.status(400).json({ message: "Closed tickets cannot receive replies until reopened by support" });

  await prisma.supportTicketMessage.create({
    data: {
      ticketId: ticket.id,
      authorType: "SALON",
      authorName: req.user.name,
      message: req.body.message,
      attachmentUrl: req.body.attachmentUrl || null
    }
  });
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: "OPEN" } });
  await prisma.supportTicketEvent.create({
    data: {
      ticketId: ticket.id,
      eventType: "REPLY_SENT",
      actorName: req.user.name,
      details: req.body.attachmentUrl ? "Salon reply sent with attachment placeholder" : "Salon reply sent",
      fromStatus: ticket.status,
      toStatus: "OPEN"
    }
  });
  res.json(await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } } }));
});
ownerRouter.patch("/support-tickets/:id", requireSalonPermission("support", "edit"), async (req, res) => {
  const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!ticket) return res.status(404).json({ message: "Support ticket not found" });
  const { status, priority } = req.body;
  const updateData = {};
  if (status) updateData.status = status;
  if (priority) updateData.priority = priority;
  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: "No valid fields to update" });
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: updateData });
  await prisma.supportTicketEvent.create({
    data: {
      ticketId: ticket.id,
      eventType: "UPDATED",
      actorName: req.user.name,
      details: `Ticket updated: ${Object.keys(updateData).join(", ")}`,
      fromStatus: ticket.status,
      toStatus: status || ticket.status
    }
  });
  res.json(await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } } }));
});

ownerRouter.get("/settings", requireSalonPermission("settings", "view"), async (req, res) => {
  const branchId = req.query.branchId ? String(req.query.branchId) : null;
  let row = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId } });
  if (!row && branchId) {
    row = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
  }
  res.json(row);
});

ownerRouter.post("/settings/crm-segment-preview", requireSalonPermission("campaigns", "view"), async (req, res) => {
  const segments = req.body.segments || [];
  const preview = {};
  for (const segment of segments) {
    if (!segment.id) continue;
    try {
      const audience = await getCampaignAudience(req.salonId, segment.filterType || "ALL_CUSTOMERS", { serviceId: segment.serviceId });
      preview[segment.id] = audience.length;
    } catch (err) {
      preview[segment.id] = 0;
    }
  }
  res.json({ preview });
});
ownerRouter.post("/settings", requireSalonPermission("settings", "edit"), validate(schemas.salonSettings), async (req, res) => {
  const branchId = req.body.branchId || null;
  const existing = await prisma.salonSetting.findFirst({
    where: { salonId: req.salonId, branchId }
  });
  
  // Deep merge advancedSettings instead of overwriting
  let advancedSettings = req.body.advancedSettings || null;
  if (advancedSettings && existing?.advancedSettings) {
    advancedSettings = { ...existing.advancedSettings, ...advancedSettings };
  }
  
  const payload = {
    invoicePrefix: req.body.invoicePrefix,
    invoiceFooter: req.body.invoiceFooter,
    taxLabel: req.body.taxLabel,
    paymentModes: req.body.paymentModes,
    whatsappNumber: req.body.whatsappNumber || null,
    bookingNotes: req.body.bookingNotes || null,
    cancellationPolicy: req.body.cancellationPolicy || null,
    allowNegativeStock: Boolean(req.body.allowNegativeStock),
    paymentGatewaySettings: req.body.paymentGatewaySettings || null,
    advancedSettings,
    smsSettings: req.body.smsSettings || null
  };
  const row = existing
    ? await prisma.salonSetting.update({
        where: { id: existing.id },
        data: payload
      })
    : await prisma.salonSetting.create({
        data: { salonId: req.salonId, ...payload, branchId }
      });
  await createAuditLog({
    salonId: req.salonId,
    actorUserId: req.user.userId,
    actorMembershipId: req.user.membershipId,
    module: "SETTINGS",
    action: existing ? "SETTINGS_UPDATED" : "SETTINGS_CREATED",
    entityType: "SalonSetting",
    entityId: row.id,
    summary: branchId ? "Branch-level settings saved" : "Salon settings saved",
    metadata: {
      branchId,
      paymentModes: payload.paymentModes,
      allowNegativeStock: payload.allowNegativeStock,
      paymentLinkEnabled: payload.paymentGatewaySettings?.paymentLinkEnabled ?? null,
      advancedSettingsSections: Object.keys(payload.advancedSettings || {}),
      smsSettingsConfigured: Boolean(payload.smsSettings)
    }
  });
  res.status(201).json(row);
});

ownerRouter.get("/website/config", requireSalonPermission("settings", "view"), async (req, res) => {
  const salon = await prisma.salon.findUnique({
    where: { id: req.salonId },
    select: { featureFlags: true }
  });
  const featureFlags = typeof salon?.featureFlags === "object" && salon.featureFlags ? salon.featureFlags : {};
  const websiteConfig = typeof featureFlags.websiteConfig === "object" && featureFlags.websiteConfig ? featureFlags.websiteConfig : {};
  res.json({
    heroTitle: String(websiteConfig.heroTitle || ""),
    heroSubtitle: String(websiteConfig.heroSubtitle || ""),
    heroImage: String(websiteConfig.heroImage || "")
  });
});

ownerRouter.post("/website/config", requireSalonPermission("settings", "edit"), async (req, res) => {
  const salon = await prisma.salon.findUnique({
    where: { id: req.salonId },
    select: { featureFlags: true }
  });
  const featureFlags = typeof salon?.featureFlags === "object" && salon.featureFlags ? salon.featureFlags : {};
  const websiteConfig = {
    heroTitle: String(req.body.heroTitle || "").trim(),
    heroSubtitle: String(req.body.heroSubtitle || "").trim(),
    heroImage: String(req.body.heroImage || "").trim()
  };
  await prisma.salon.update({
    where: { id: req.salonId },
    data: {
      featureFlags: {
        ...featureFlags,
        websiteConfig
      }
    }
  });
  await createAuditLog({
    salonId: req.salonId,
    actorUserId: req.user.userId,
    actorMembershipId: req.user.membershipId,
    module: "SETTINGS",
    action: "WEBSITE_CONFIG_UPDATED",
    entityType: "Salon",
    entityId: req.salonId,
    summary: "Website editor configuration updated",
    metadata: websiteConfig
  });
  res.json(websiteConfig);
});

ownerRouter.get("/reports/trends", requireSalonPermission("reports", "view"), async (req, res) => {
  const range = req.query.range || "7D";
  const filter = String(req.query.filter || "overall").toLowerCase();
  const period = String(req.query.period || "week").toLowerCase();

  let days = 7;
  if (range === "1D")  days = 1;
  if (range === "14D") days = 14;
  if (range === "1M")  days = 30;
  if (range === "2M")  days = 60;
  if (range === "YTD") days = Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 86400000) || 1;
  if (range === "1Y")  days = 365;

  // Override days based on period (trend line granularity)
  let periodDays = days;
  if (period === "month") periodDays = 30;
  if (period === "3m")    periodDays = 90;
  if (period === "6m")    periodDays = 180;
  if (period === "1y")    periodDays = 365;
  if (period === "5y")    periodDays = Math.min(1825, days);

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - Math.max(days, periodDays));
  startDate.setHours(0,0,0,0);

  const statsStartDate = new Date();
  statsStartDate.setDate(statsStartDate.getDate() - days);
  statsStartDate.setHours(0,0,0,0);

  const branchId = normalizeBranchId(req.query.branchId);
  const allInvoices = await prisma.invoice.findMany({
    where: {
      salonId: req.salonId,
      status: "PAID",
      createdAt: { gte: startDate },
      ...(branchId ? { branchId } : {})
    },
    include: {
      items: true
    }
  });

  const invoices = allInvoices.filter(inv => inv.createdAt >= statsStartDate);

  // Helper to determine if an item should be included based on the active filter
  const itemMatchesFilter = (item) => {
    const type = item.itemType || "SERVICE";
    if (filter === "overall") return true;
    if (filter === "service") return type === "SERVICE";
    if (filter === "product") return type === "PRODUCT";
    if (filter === "stylist") return !!item.staffName;  // only items with staff
    return true;
  };

  let serviceRev = 0, productRev = 0, packageRev = 0, membershipRev = 0, giftCardRev = 0;

  invoices.forEach(inv => {
    inv.items.forEach(item => {
      if (!itemMatchesFilter(item)) return;
      const type  = item.itemType || "SERVICE";
      const total = Number(item.lineTotal || 0);
      if (type === "SERVICE")    serviceRev    += total;
      if (type === "PRODUCT")    productRev    += total;
      if (type === "PACKAGE")    packageRev    += total;
      if (type === "MEMBERSHIP") membershipRev += total;
      if (type === "GIFT_CARD")  giftCardRev   += total;
    });
  });

  const totalRev = serviceRev + productRev + packageRev + membershipRev + giftCardRev;

  // Build revenue split based on filter
  let revenueSplit;
  if (filter === "overall") {
    revenueSplit = [
      { name: "Total",      value: totalRev,        fill: "#6366f1" },
      { name: "Service",    value: serviceRev,      fill: "#3b82f6" },
      { name: "Product",    value: productRev,      fill: "#10b981" },
      { name: "Package",    value: packageRev,      fill: "#f59e0b" },
      { name: "Membership", value: membershipRev,   fill: "#ec4899" },
      { name: "Gift Card",  value: giftCardRev,     fill: "#8b5cf6" }
    ];
  } else if (filter === "service") {
    revenueSplit = [
      { name: "Service", value: serviceRev, fill: "#3b82f6" }
    ];
  } else if (filter === "product") {
    revenueSplit = [
      { name: "Product", value: productRev, fill: "#10b981" }
    ];
  } else if (filter === "stylist") {
    // For stylist, we'll show staff names as categories
    const stylistMap = {};
    invoices.forEach(inv => {
      inv.items.forEach(item => {
        if (!item.staffName) return;
        stylistMap[item.staffName] = (stylistMap[item.staffName] || 0) + Number(item.lineTotal || 0);
      });
    });
    revenueSplit = Object.entries(stylistMap)
      .map(([name, value]) => ({ name, value, fill: "#6366f1" }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
    if (revenueSplit.length === 0) revenueSplit = [{ name: "Stylist Revenue", value: totalRev, fill: "#6366f1" }];
  } else {
    revenueSplit = [
      { name: "Total", value: totalRev, fill: "#6366f1" }
    ];
  }

  // daily trend line
  const dateMap = {};
  const totalDays = Math.max(periodDays, 1);
  for (let i = 0; i < totalDays; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (totalDays - 1 - i));
    const dateStr = d.toISOString().slice(0, 10);
    dateMap[dateStr] = { date: dateStr, total: 0, service: 0, product: 0, package: 0, membership: 0 };
  }

  allInvoices.forEach(inv => {
    const dStr = inv.createdAt.toISOString().slice(0, 10);
    if (dateMap[dStr]) {
      inv.items.forEach(item => {
        if (!itemMatchesFilter(item)) return;
        const type = item.itemType || "SERVICE";
        const t    = Number(item.lineTotal || 0);
        dateMap[dStr].total += t;
        if (type === "SERVICE")    dateMap[dStr].service    += t;
        if (type === "PRODUCT")    dateMap[dStr].product    += t;
        if (type === "PACKAGE")    dateMap[dStr].package    += t;
        if (type === "MEMBERSHIP") dateMap[dStr].membership += t;
      });
    }
  });

  // top services — based on filter
  const serviceMap = {};
  invoices.forEach(inv => {
    inv.items
      .filter(i => (i.itemType || "SERVICE") === "SERVICE" && itemMatchesFilter(i))
      .forEach(item => {
        const name = item.serviceName || "Unknown";
        serviceMap[name] = (serviceMap[name] || 0) + Number(item.lineTotal || 0);
      });
  });
  const topServices = Object.entries(serviceMap)
    .map(([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // top staff — based on filter
  const staffMap = {};
  invoices.forEach(inv => {
    inv.items.forEach(item => {
      if (!item.staffName) return;
      if (!itemMatchesFilter(item)) return;
      staffMap[item.staffName] = (staffMap[item.staffName] || 0) + Number(item.lineTotal || 0);
    });
  });
  const topStaff = Object.entries(staffMap)
    .map(([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  res.json({
    revenueSplit,
    trendLine:   Object.values(dateMap),
    topServices,
    topStaff,
    summary: {
      totalInvoices: invoices.length,
      totalRevenue:  totalRev,
      avgBillValue:  invoices.length ? Math.round(totalRev / invoices.length) : 0,
    }
  });
});

ownerRouter.get("/subscription", async (req, res) => {
  try {
    const salonId = req.salonId || req.user?.salonId;
    if (!salonId) return res.json(null);
    const sub = await prisma.subscription.findFirst({
      where: { salonId },
      include: { plan: true },
      orderBy: { startsAt: "desc" }
    });
    res.json(sub || null);
  } catch {
    res.json(null);
  }
});

ownerRouter.post("/users/send-staff-otp", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ message: "Please enter a valid 10-digit Indian mobile number." });
  const otpCode = generateOtp();
  const salonId = req.salonId || req.user?.salonId;
  const key = `staff_otp:${salonId}:${phone}`;
  phoneOtpStore.set(key, { otpCode, expiresAt: Date.now() + PHONE_OTP_TTL_MS });

  try {
    const { sendWhatsApp } = await import("../../lib/whatsappService.js");
    await sendWhatsApp({ salonId, to: phone, message: `Your Salon Nest verification code is ${otpCode}. It expires in 5 minutes.` }).catch(() => {});
  } catch {}

  res.json({ ok: true, message: "OTP sent successfully" });
});

ownerRouter.get("/referrals/wallets/:customerId", async (req, res) => {
  try {
    const salonId = req.salonId || req.user?.salonId;
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.customerId, salonId },
      select: { id: true, name: true, phone: true }
    });
    res.json({ wallet: customer ? { balance: 0, credits: 0 } : null });
  } catch {
    res.json({ wallet: null });
  }
});

ownerRouter.post("/referrals/coupons/validate", async (req, res) => {
  const { code } = req.body || {};
  return res.status(404).json({ message: `Coupon '${code || ""}' is not valid or expired.` });
});

// ─── Phone verification (OTP) ───────────────────────────────────────────────
const phoneOtpStore = new Map();
const PHONE_OTP_TTL_MS = 5 * 60 * 1000;
const normalizePhone = (value) => {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
};
const maskPhone = (phone) => (phone ? `${phone.slice(0, 5)}****${phone.slice(-3)}` : null);
const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

ownerRouter.get("/verify-phone/info", async (req, res) => {
  try {
    const membership = req.user?.membershipId
      ? await prisma.userSalon.findUnique({ where: { id: req.user.membershipId }, select: { phone: true } })
      : null;
    const phone = membership?.phone || null;
    res.json({
      phone,
      maskedPhone: maskPhone(phone),
      isPhoneVerified: Boolean(phone),
      canSkip: true
    });
  } catch {
    res.json({ phone: null, maskedPhone: null, isPhoneVerified: false, canSkip: true });
  }
});

ownerRouter.post("/verify-phone/send", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ message: "Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9." });

  const otpCode = generateOtp();
  const key = `${req.user.userId}:${phone}`;
  phoneOtpStore.set(key, { otpCode, expiresAt: Date.now() + PHONE_OTP_TTL_MS, attempts: 0 });

  let channel = "sms";
  let delivered = false;
  try {
    const { sendWhatsApp } = await import("../../lib/whatsappService.js");
    await sendWhatsApp({ salonId: req.user.salonId, to: phone, message: `Your Salon Nest verification code is ${otpCode}. It expires in 5 minutes.` });
    delivered = true;
    channel = "whatsapp";
  } catch {
    try {
      const { sendSms } = await import("../../lib/smsService.js");
      await sendSms({ salonId: req.user.salonId, to: phone, message: `Your Salon Nest verification code is ${otpCode}. It expires in 5 minutes.` });
      delivered = true;
      channel = "sms";
    } catch {
      delivered = false;
    }
  }

  return res.json({
    message: delivered
      ? `OTP sent via ${channel === "whatsapp" ? "WhatsApp" : "SMS"}.`
      : "Verification code generated. Use the code shown to continue.",
    channel: delivered ? channel : null,
    ...(process.env.NODE_ENV !== "production" ? { otpCode } : {})
  });
});

ownerRouter.post("/verify-phone/verify", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otpCode = String(req.body?.otpCode || "").trim();
  if (!phone || otpCode.length !== 6) return res.status(400).json({ message: "Please enter the complete 6-digit OTP code." });

  const key = `${req.user.userId}:${phone}`;
  const record = phoneOtpStore.get(key);
  if (!record || record.expiresAt < Date.now()) {
    phoneOtpStore.delete(key);
    return res.status(400).json({ message: "This code has expired. Please request a new one." });
  }
  record.attempts += 1;
  if (record.attempts > 5) {
    phoneOtpStore.delete(key);
    return res.status(429).json({ message: "Too many attempts. Please request a new code." });
  }
  if (record.otpCode !== otpCode) return res.status(400).json({ message: "Invalid OTP. Please check the code and retry." });

  phoneOtpStore.delete(key);
  try {
    if (req.user.membershipId) {
      await prisma.userSalon.update({ where: { id: req.user.membershipId }, data: { phone } });
    }
  } catch {
    // non-fatal: verification already succeeded
  }

  return res.json({ message: "Phone number verified successfully.", phone });
});

ownerRouter.post("/verify-phone/skip", async (req, res) => {
  const settings = await prisma.salonSetting.findFirst({
    where: { salonId: req.user.salonId, branchId: null },
    select: { advancedSettings: true }
  });
  const mandatory = settings?.advancedSettings?.accessControl?.requirePhoneVerification === true;
  if (mandatory) {
    return res.status(403).json({ message: "Mobile verification is mandatory on this platform." });
  }
  return res.json({ message: "Phone verification skipped.", skipped: true });
});

ownerRouter.get("/products", async (req, res) => {
  const where = { salonId: req.user.salonId, isActive: true };
  if (req.query.branchId) where.branchId = req.query.branchId;
  const products = await prisma.product.findMany({
    where,
    include: { category: true, branch: { select: { id: true, name: true } } },
    orderBy: { name: "asc" }
  });
  res.json(products);
});

ownerRouter.get("/product-catalog", async (req, res) => {
  try {
    const catalog = await prisma.productRequirement.findMany({
      where: { salonId: null },
      orderBy: { createdAt: "desc" }
    });
    res.json(catalog);
  } catch (error) {
    res.status(500).json({ message: "Failed to load product catalog" });
  }
});

ownerRouter.get("/product-requirements", async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.priority) where.priority = req.query.priority;
  if (req.query.branchId) where.branchId = req.query.branchId;
  if (req.query.q) {
    where.OR = [
      { productName: { contains: req.query.q, mode: "insensitive" } },
      { description: { contains: req.query.q, mode: "insensitive" } },
      { vendor: { contains: req.query.q, mode: "insensitive" } }
    ];
  }
  const rows = await prisma.productRequirement.findMany({ where, orderBy: { createdAt: "desc" } });
  res.json(rows);
});

ownerRouter.post("/product-requirements", async (req, res) => {
  const row = await prisma.productRequirement.create({ data: {
    productName: req.body.productName,
    description: req.body.description || null,
    category: req.body.category || null,
    quantity: req.body.requiredQty || req.body.quantity || 1,
    unitPrice: req.body.unitCost || req.body.unitPrice || null,
    priority: req.body.priority || "MEDIUM",
    status: req.body.status || "PENDING",
    vendor: req.body.vendor || null
  }});
  res.status(201).json(row);
});

ownerRouter.patch("/product-requirements/:id", async (req, res) => {
  const existing = await prisma.productRequirement.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Not found" });
  const data = {};
  if (req.body.productName !== undefined) data.productName = req.body.productName;
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.category !== undefined) data.category = req.body.category;
  if (req.body.requiredQty !== undefined || req.body.quantity !== undefined) data.quantity = req.body.requiredQty || req.body.quantity;
  if (req.body.unitCost !== undefined || req.body.unitPrice !== undefined) data.unitPrice = req.body.unitCost || req.body.unitPrice;
  if (req.body.priority !== undefined) data.priority = req.body.priority;
  if (req.body.status !== undefined) data.status = req.body.status;
  if (req.body.vendor !== undefined) data.vendor = req.body.vendor;
  res.json(await prisma.productRequirement.update({ where: { id: req.params.id }, data }));
});

ownerRouter.delete("/product-requirements/:id", async (req, res) => {
  await prisma.productRequirement.delete({ where: { id: req.params.id } });
  res.json({ message: "Deleted" });
});

ownerRouter.get("/staff-requirements", requireSalonPermission("staff", "view"), async (req, res) => {
  const where = { salonId: req.salonId };
  if (req.query.status) where.status = req.query.status;
  if (req.query.urgency) where.urgency = req.query.urgency;
  if (req.query.branchId) where.branchId = req.query.branchId;
  if (req.query.department) where.department = req.query.department;
  if (req.query.q) {
    where.OR = [
      { title: { contains: req.query.q, mode: "insensitive" } },
      { description: { contains: req.query.q, mode: "insensitive" } },
      { department: { contains: req.query.q, mode: "insensitive" } },
      { skills: { contains: req.query.q, mode: "insensitive" } }
    ];
  }
  const rows = await prisma.staffRequirement.findMany({ where, orderBy: { createdAt: "desc" } });
  res.json(rows);
});

ownerRouter.post("/staff-requirements", requireSalonPermission("staff", "create"), async (req, res) => {
  const skillsStr = Array.isArray(req.body.skills) ? req.body.skills.join(",") : (req.body.skills || null);
  const row = await prisma.staffRequirement.create({ data: {
    salonId: req.salonId,
    branchId: req.body.branchId || null,
    title: req.body.title,
    description: req.body.description || null,
    department: req.body.department || null,
    position: req.body.position || null,
    salary: req.body.salary || null,
    shift: req.body.shift || "Full-Time",
    urgency: req.body.urgency || "MEDIUM",
    skills: skillsStr,
    count: Number(req.body.quantity) || Number(req.body.count) || 1,
    priority: req.body.priority || "MEDIUM",
    status: req.body.status || "OPEN"
  }});
  res.status(201).json(row);
});

ownerRouter.patch("/staff-requirements/:id", requireSalonPermission("staff", "edit"), async (req, res) => {
  const existing = await prisma.staffRequirement.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!existing) return res.status(404).json({ message: "Not found" });
  const data = {};
  if (req.body.title !== undefined) data.title = req.body.title;
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.department !== undefined) data.department = req.body.department;
  if (req.body.position !== undefined) data.position = req.body.position;
  if (req.body.salary !== undefined) data.salary = req.body.salary;
  if (req.body.shift !== undefined) data.shift = req.body.shift;
  if (req.body.urgency !== undefined) data.urgency = req.body.urgency;
  if (req.body.priority !== undefined) data.priority = req.body.priority;
  if (req.body.status !== undefined) data.status = req.body.status;
  if (req.body.branchId !== undefined) data.branchId = req.body.branchId || null;
  if (req.body.quantity !== undefined || req.body.count !== undefined) data.count = Number(req.body.quantity) || Number(req.body.count);
  if (req.body.skills !== undefined) data.skills = Array.isArray(req.body.skills) ? req.body.skills.join(",") : (req.body.skills || null);
  res.json(await prisma.staffRequirement.update({ where: { id: req.params.id }, data }));
});

ownerRouter.delete("/staff-requirements/:id", requireSalonPermission("staff", "delete"), async (req, res) => {
  const existing = await prisma.staffRequirement.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!existing) return res.status(404).json({ message: "Not found" });
  await prisma.staffRequirement.delete({ where: { id: req.params.id } });
  res.json({ message: "Deleted" });
});





ownerRouter.get("/salon-details", requireSalonPermission("settings", "view"), async (req, res) => {
  const salon = await prisma.salon.findUnique({
    where: { id: req.salonId },
    select: {
      id: true, name: true, slug: true, businessType: true, email: true, phone: true,
      address: true, city: true, currency: true, taxRate: true, status: true,
      createdAt: true, trialStartsAt: true, trialEndsAt: true,
      _count: { select: { branches: true, users: true, services: true, customers: true, invoices: true, products: true } }
    }
  });
  if (!salon) return res.status(404).json({ message: "Salon not found" });

  const subscription = await prisma.subscription.findFirst({
    where: { salonId: req.salonId },
    include: { plan: { select: { id: true, name: true, branchLimit: true, userLimit: true, customerLimit: true, invoiceLimit: true, storageLimit: true, monthlyPrice: true, yearlyPrice: true } } },
    orderBy: { startsAt: "desc" }
  });

  const branches = await prisma.branch.findMany({
    where: { salonId: req.salonId },
    select: { id: true, name: true, isActive: true }
  });

  res.json({ salon, subscription: subscription || null, branches });
});

registerPhase2OwnerRoutes(ownerRouter);
registerPhase3OwnerRoutes(ownerRouter);
registerPhase4OwnerRoutes(ownerRouter);
registerMissingOwnerRoutes(ownerRouter);

ownerRouter.post("/_test-email-templates", async (req, res) => {
  const { sendMail } = await import("../../lib/mailer.js");
  const TO = req.body.email || "ahmedbilalkhangl09@gmail.com";

  const allTemplates = [
    { name: "1. Invoice Generated", title: "Invoice Generated", content: `Hi Ahmed,<br/><br/>Your invoice from <strong>{{salon_name}}</strong> has been generated.<br/><br/><strong>Invoice Number:</strong> INV-2026-001<br/><strong>Total Amount:</strong> Rs.2,500.00<br/><br/>If you have any questions, please contact our front desk.` },
    { name: "2. Invoice Refund", title: "Invoice Refund Processed", content: `Hi Ahmed,<br/><br/>A refund has been processed against your recent invoice at <strong>{{salon_name}}</strong>.<br/><br/>The amount should reflect in your account shortly depending on your payment method. For any queries, please contact our front desk.` },
    { name: "3. Invoice Cancelled", title: "Invoice Cancelled", content: `Hi Ahmed,<br/><br/>Your recent invoice at <strong>{{salon_name}}</strong> has been cancelled.<br/><br/>If you did not request this cancellation, please contact our front desk immediately.` },
    { name: "4. Membership Welcome", title: "Welcome to your Membership", content: `Hi Ahmed,<br/><br/>Your membership at <strong>{{salon_name}}</strong> is now active.<br/><br/>You can now enjoy all your exclusive benefits and perks.<br/><br/><strong>Valid until:</strong> August 6, 2027` },
    { name: "5. Package Purchase", title: "Your Package is Active", content: `Hi Ahmed,<br/><br/>Your package at <strong>{{salon_name}}</strong> is now active.<br/><br/><strong>Sessions available:</strong> 10<br/><br/>We look forward to seeing you for your next session.` },
    { name: "6. Payment Receipt", title: "Payment Receipt", content: `Hi Ahmed,<br/><br/>We have received your payment of <strong>Rs.2,500.00</strong> at <strong>{{salon_name}}</strong>.<br/><br/>Thank you for your payment.` },
    { name: "7. Appointment Confirmed", title: "Appointment Confirmed", content: `Hi Ahmed,<br/><br/>Your appointment at <strong>{{salon_name}}</strong> has been confirmed.<br/><br/><strong>Date & Time:</strong> Thursday, August 06, 2026 at 10:00 AM<br/><br/>If you need to reschedule, please contact us at your earliest convenience.` },
    { name: "8. Appointment Reminder", title: "Appointment Reminder", content: `Hi Ahmed,<br/><br/>This is a reminder that you have an upcoming appointment at <strong>{{salon_name}}</strong>.<br/><br/><strong>Date & Time:</strong> Thursday, August 06, 2026 at 10:00 AM<br/><br/>We look forward to seeing you.` },
    { name: "9. Appointment Cancelled", title: "Appointment Cancelled", content: `Hi Ahmed,<br/><br/>Your appointment at <strong>{{salon_name}}</strong> scheduled for <strong>Thursday, August 06, 2026 at 10:00 AM</strong> has been cancelled.<br/><br/>We hope to see you again soon.` },
    { name: "10. Order Confirmation", title: "Order Confirmation", content: `Hi Ahmed,<br/><br/>Thank you for your order from <strong>{{salon_name}}</strong>.<br/><br/><strong>Order Number:</strong> ORD-2026-042<br/><strong>Total Amount:</strong> Rs.1,200.00<br/><br/>We are processing your order and will keep you updated.` },
    { name: "11. Enquiry Follow Up", title: "Update on your Enquiry", content: `Hi Ahmed,<br/><br/>Thank you for contacting <strong>{{salon_name}}</strong>. Our team has reviewed your enquiry and left an update for you.<br/><br/>We will stay in touch to ensure everything is resolved.` },
    { name: "12. Feedback Follow Up", title: "Update on your Feedback", content: `Hi Ahmed,<br/><br/>Thank you for sharing your feedback with <strong>{{salon_name}}</strong>. We take your comments seriously and our team has an update regarding your experience.<br/><br/>We are committed to providing you with the best possible service.` },
    { name: "13. Feedback Request", title: "How was your experience?", content: `Hi Ahmed,<br/><br/>Thank you for your recent visit to <strong>{{salon_name}}</strong>. We hope you had a great experience.<br/><br/>We would love to hear your thoughts. Please share your feedback at your convenience.` },
    { name: "14. Birthday Offer", title: "Happy Birthday", content: `Hi Ahmed,<br/><br/>Wishing you a very Happy Birthday from all of us at <strong>{{salon_name}}</strong>.<br/><br/>We have a special birthday treat waiting for you. Visit us soon to claim it.` },
    { name: "15. Anniversary Offer", title: "Happy Anniversary", content: `Hi Ahmed,<br/><br/>Happy Anniversary from <strong>{{salon_name}}</strong>.<br/><br/>Celebrate with a special pampering session. We have an exclusive anniversary offer just for you.` },
    { name: "16. Loyalty Points Earned", title: "Loyalty Points Earned", content: `Hi Ahmed,<br/><br/>You have earned <strong>50 loyalty points</strong> at <strong>{{salon_name}}</strong>.<br/><br/><strong>Your new balance:</strong> 250 points.<br/><br/>Keep visiting to unlock exciting rewards.` },
    { name: "17. Loyalty Points Expiring", title: "Loyalty Points Expiring Soon", content: `Hi Ahmed,<br/><br/>Your loyalty points at <strong>{{salon_name}}</strong> are expiring soon.<br/><br/>Book your next visit today and redeem your points before they expire.` },
    { name: "18. Membership Expiring", title: "Membership Expiring Soon", content: `Hi Ahmed,<br/><br/>Your membership at <strong>{{salon_name}}</strong> is expiring on <strong>August 6, 2026</strong>.<br/><br/>Renew now to continue enjoying your VIP perks and discounts.` },
    { name: "19. Membership Renewed", title: "Membership Renewed", content: `Hi Ahmed,<br/><br/>Your membership at <strong>{{salon_name}}</strong> has been renewed successfully.<br/><br/><strong>New expiry date:</strong> August 6, 2027<br/><br/>Thank you for being a valued member.` },
    { name: "20. Package Expiring", title: "Package Expiring Soon", content: `Hi Ahmed,<br/><br/>Your package at <strong>{{salon_name}}</strong> is nearing its expiration date.<br/><br/><strong>Sessions remaining:</strong> 3<br/><br/>Book your appointments before they expire.` },
    { name: "21. Gift Card Received", title: "Gift Card Received", content: `Hi Ahmed,<br/><br/>You have received a gift card from <strong>{{salon_name}}</strong>.<br/><br/><strong>Code:</strong> GIFT-ABCD-1234<br/><strong>Value:</strong> Rs.1,000.00<br/><br/>Show this code at the desk on your next visit to redeem.` },
    { name: "22. Gift Card Expiring", title: "Gift Card Expiring Soon", content: `Hi Ahmed,<br/><br/>Your gift card at <strong>{{salon_name}}</strong> is expiring soon.<br/><br/>Book your appointment and redeem your balance before it expires.` },
    { name: "23. Gift Card Redeemed", title: "Gift Card Redeemed", content: `Hi Ahmed,<br/><br/>Your gift card (Code: GIFT-ABCD-1234) has been used for <strong>Rs.500.00</strong> at <strong>{{salon_name}}</strong>.<br/><br/><strong>Remaining Balance:</strong> Rs.500.00` },
    { name: "24. Referral Code", title: "Your Referral Code", content: `Hi Ahmed,<br/><br/>Here is your personal referral code for <strong>{{salon_name}}</strong>:<br/><br/><strong>AHMED-REF-2026</strong><br/><br/>Share this code with your friends and family. When they visit us, you both earn rewards.` },
    { name: "25. Referral Reward", title: "Referral Reward Earned", content: `Hi Ahmed,<br/><br/>A friend used your referral code and you have earned <strong>100 loyalty points</strong> at <strong>{{salon_name}}</strong>.<br/><br/>Keep sharing your code to keep earning rewards.` },
    { name: "26. Welcome Email", title: "Welcome to {{salon_name}}", content: `Hi Ahmed,<br/><br/>Welcome to <strong>{{salon_name}}</strong>! Your account has been created successfully.<br/><br/>We are excited to have you on board. Explore our services and book your first appointment today.` }
  ];

  const salonName = "Skillify";
  const wrapHtml = (body) => `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 40px 20px; color: #0f172a; line-height: 1.6;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01); border: 1px solid #e2e8f0;">
        <div style="background: linear-gradient(135deg, #0f172a, #1e293b); padding: 32px 24px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">${salonName}</h1>
        </div>
        <div style="padding: 40px 32px;">
          <div style="font-size: 16px; color: #334155; margin-bottom: 24px; white-space: pre-wrap;">${body}</div>
        </div>
        <div style="background-color: #f1f5f9; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="font-size: 13px; color: #64748b; margin: 0; font-weight: 500;">&copy; 2026 ${salonName}. All rights reserved.</p>
          <p style="font-size: 12px; color: #94a3b8; margin: 8px 0 0 0;">This is an automated notification. Please do not reply directly to this email.</p>
        </div>
      </div>
    </div>`;

  const results = [];
  for (const tmpl of allTemplates) {
    try {
      await sendMail({
        to: TO,
        subject: `[Skillify Preview] ${tmpl.title}`,
        html: wrapHtml(tmpl.content),
        text: tmpl.content.replace(/<[^>]+>/g, "")
      });
      results.push({ name: tmpl.name, status: "sent" });
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      results.push({ name: tmpl.name, status: "failed", error: err.message });
    }
  }

  res.json({ total: allTemplates.length, sent: results.filter(r => r.status === "sent").length, failed: results.filter(r => r.status === "failed").length, details: results });
});
