import { prisma } from "../../../lib/prisma.js";

export const buildAppointmentScope = (req, branchId = null) => {
  const ownOnly = req.user.salonRole === "STAFF" && !(req.user.permissions?.appointments || []).includes("manage_all");
  return {
    salonId: req.salonId,
    ...(branchId ? { branchId } : {}),
    ...(ownOnly ? { OR: [
      { items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } } },
      { primaryStaffUserId: req.user.membershipId }
    ] } : {})
  };
};

export const canAccessAppointment = (req, appointment) => {
  if (!appointment) return false;
  const ownOnly = req.user.salonRole === "STAFF" && !(req.user.permissions?.appointments || []).includes("manage_all");
  if (!ownOnly) return true;
  if (appointment.primaryStaffUserId === req.user.membershipId) return true;
  return (appointment.items || []).some((item) =>
    (item.assignedStaff || []).some((assignment) => assignment.userSalonId === req.user.membershipId)
  );
};

export const fetchAppointment = (salonId, id) =>
  prisma.appointment.findFirst({
    where: { id, salonId },
    include: {
      customer: true,
      branch: true,
      primaryStaff: { include: { user: true } },
      items: {
        include: {
          service: { include: { consumables: { include: { product: true } } } },
          assignedStaff: { include: { userSalon: { include: { user: true } } } }
        }
      },
      logs: { orderBy: { createdAt: "asc" } }
    }
  });

export const logAppointmentChange = async (tx, appointmentId, actorUserId, action, fromStatus, toStatus, details) =>
  tx.appointmentLog.create({
    data: { appointmentId, actorUserId, action, fromStatus, toStatus, details: details || null }
  });

export const nextNumber = async (tx, model, salonId, prefix) => {
  const latest = await tx[model].findFirst({
    where: { salonId },
    orderBy: { createdAt: "desc" }
  });
  const lastNum = latest?.invoiceNumber || latest?.appointmentNumber || latest?.poNumber || latest?.orderNumber;
  const lastSeq = lastNum ? parseInt(String(lastNum).split("-").pop(), 10) || 0 : 0;
  return `${prefix}-${String(lastSeq + 1).padStart(5, "0")}`;
};

export const assignAppointmentItems = async (tx, appointmentId, items) => {
  const existingItems = await tx.appointmentService.findMany({
    where: { appointmentId },
    select: { id: true }
  });
  if (existingItems.length) {
    await tx.appointmentServiceStaff.deleteMany({
      where: { appointmentServiceId: { in: existingItems.map((item) => item.id) } }
    });
  }
  await tx.appointmentService.deleteMany({ where: { appointmentId } });
  for (const item of items) {
    const createdItem = await tx.appointmentService.create({
      data: {
        appointmentId,
        serviceId: item.serviceId,
        startAt: new Date(item.startAt),
        endAt: new Date(item.endAt),
        notes: item.notes || null
      }
    });
    if (Array.isArray(item.staffUserIds) && item.staffUserIds.filter(Boolean).length > 0) {
      await tx.appointmentServiceStaff.createMany({
        data: item.staffUserIds.filter(Boolean).map((userSalonId) => ({ appointmentServiceId: createdItem.id, userSalonId })),
        skipDuplicates: true
      });
    }
  }
};
