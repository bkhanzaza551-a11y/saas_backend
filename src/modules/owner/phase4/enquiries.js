import ExcelJS from "exceljs";
import multer from "multer";
import { buildCsv } from "../../../lib/phase2.js";

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});
import { prisma } from "../../../lib/prisma.js";
import { attemptCustomerTemplateEmail } from "../../../lib/emailNotifications.js";
import { createAuditLog, createStaffNotification } from "../../../lib/phase4.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const toDate = (value) => (value ? new Date(value) : null);

export const registerEnquiryRoutes = (ownerRouter) => {
  ownerRouter.get("/enquiries", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    const allAccess = (req.user.permissions?.enquiries || []).includes("view");
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const where = {
      salonId: req.salonId,
      ...(branchId ? { interestedBranchId: branchId } : {}),
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(!allAccess && req.user.membershipId ? { assignedToMembershipId: req.user.membershipId } : {})
    };
    res.json(await prisma.enquiry.findMany({
      where,
      include: { interestedService: true, interestedBranch: true, assignedToMembership: { include: { user: true } }, followUps: { orderBy: { createdAt: "desc" } } },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.post("/enquiries", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "create"), validate(schemas.enquiry), async (req, res) => {
    const row = await prisma.enquiry.create({
      data: {
        salonId: req.salonId,
        name: req.body.name,
        phone: req.body.phone,
        email: req.body.email || null,
        source: req.body.source,
        interestedServiceId: req.body.interestedServiceId || null,
        interestedBranchId: req.body.interestedBranchId || null,
        budget: req.body.budget ?? null,
        priority: req.body.priority || "MEDIUM",
        assignedToMembershipId: req.body.assignedToMembershipId || null,
        createdByMembershipId: req.user.membershipId || null,
        followUpAt: toDate(req.body.followUpAt),
        notes: req.body.notes || null
      }
    });

    // Auto-sync customer database so lead is automatically present in customers table
    if (row.phone) {
      try {
        const cleanPhone = String(row.phone).trim();
        const existingCustomer = await prisma.customer.findFirst({
          where: { salonId: req.salonId, phone: cleanPhone }
        });
        if (!existingCustomer) {
          await prisma.customer.create({
            data: {
              salonId: req.salonId,
              name: row.name?.trim() || "Walk-in Lead",
              phone: cleanPhone,
              email: row.email?.trim() || null,
              gender: "OTHER",
              source: row.source || "WALK_IN",
              notes: row.notes || "Auto-created from Enquiry"
            }
          });
        }
      } catch (err) {
        console.warn("Auto-sync customer warning:", err.message);
      }
    }

    if (row.followUpAt) {
      await createStaffNotification({
        salonId: req.salonId,
        userSalonId: row.assignedToMembershipId || null,
        title: "Enquiry follow-up scheduled",
        message: `${row.name} requires follow-up.`,
        type: "ENQUIRY_FOLLOW_UP",
        linkUrl: `/admin/enquiries/${row.id}`
      });
    }
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ENQUIRIES",
      action: "ENQUIRY_CREATED",
      entityType: "Enquiry",
      entityId: row.id,
      summary: `Enquiry created for ${row.name}`
    });
    res.status(201).json(row);
  });

  ownerRouter.get("/enquiries/follow-ups", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    res.json(await prisma.enquiryFollowUp.findMany({
      where: { enquiry: { salonId: req.salonId } },
      include: { enquiry: true, actorMembership: { include: { user: true } } },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.get("/enquiries/reports", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const rows = await prisma.enquiry.findMany({ where: { salonId: req.salonId, ...(branchId ? { interestedBranchId: branchId } : {}) }, include: { interestedBranch: true, interestedService: true } });
    const statusBreakdown = rows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});
    const sourceBreakdown = rows.reduce((acc, row) => {
      acc[row.source] = (acc[row.source] || 0) + 1;
      return acc;
    }, {});
    res.json({
      total: rows.length,
      converted: rows.filter((row) => row.status === "CONVERTED").length,
      statusBreakdown,
      sourceBreakdown,
      rows
    });
  });

  
  ownerRouter.get("/enquiries/export", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    const { format } = req.query;
    const allAccess = (req.user.permissions?.enquiries || []).includes("view");
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const phone = req.query.phone ? String(req.query.phone).trim() : "";
    const fromDate = req.query.fromDate ? new Date(req.query.fromDate) : null;
    const toDate = req.query.toDate ? new Date(req.query.toDate) : null;
    if (toDate) toDate.setHours(23, 59, 59, 999);

    const where = {
      salonId: req.salonId,
      ...(branchId ? { interestedBranchId: branchId } : {}),
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(phone ? { phone: { contains: phone } } : {}),
      ...(fromDate || toDate ? {
        createdAt: {
          ...(fromDate ? { gte: fromDate } : {}),
          ...(toDate ? { lte: toDate } : {})
        }
      } : {}),
      ...(!allAccess && req.user.membershipId ? { assignedToMembershipId: req.user.membershipId } : {})
    };

    const enquiries = await prisma.enquiry.findMany({
      where,
      include: {
        interestedService: true,
        interestedBranch: true,
        assignedToMembership: { include: { user: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    const headers = [
      "Date",
      "Client Name",
      "Mobile No",
      "Email",
      "Service Interested",
      "Source",
      "Priority",
      "Status",
      "Budget",
      "Follow-up Date",
      "Branch",
      "Assigned Staff",
      "Notes"
    ];

    const rows = enquiries.map((e) => [
      e.createdAt ? e.createdAt.toISOString().slice(0, 10) : "",
      e.name || "",
      e.phone || "",
      e.email || "",
      e.interestedService?.name || "",
      e.source || "",
      e.priority || "MEDIUM",
      e.status || "NEW",
      e.budget ? Number(e.budget).toString() : "",
      e.followUpAt ? e.followUpAt.toISOString().slice(0, 10) : "",
      e.interestedBranch?.name || "",
      e.assignedToMembership?.user?.name || "",
      e.notes || ""
    ]);

    const isExcel = String(format).toLowerCase() === "xls" || String(format).toLowerCase() === "xlsx" || String(format).toLowerCase() === "excel";
    if (isExcel) {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Respark ERP";
      workbook.created = new Date();
      const worksheet = workbook.addWorksheet("Enquiries");

      worksheet.columns = [
        { width: 14 },
        { width: 22 },
        { width: 18 },
        { width: 26 },
        { width: 22 },
        { width: 16 },
        { width: 14 },
        { width: 16 },
        { width: 14 },
        { width: 16 },
        { width: 20 },
        { width: 20 },
        { width: 32 }
      ];

      const headerRow = worksheet.addRow(headers);
      headerRow.height = 28;
      headerRow.eachCell((cell) => {
        cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });

      rows.forEach((rowValues) => {
        const row = worksheet.addRow(rowValues);
        row.height = 20;
        row.eachCell((cell) => {
          cell.font = { name: "Calibri", size: 10 };
          cell.alignment = { vertical: "middle" };
        });
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="Enquiries_Export.xlsx"');
      await workbook.xlsx.write(res);
      return res.end();
    }

    const csv = buildCsv(headers, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="Enquiries_Export.csv"');
    return res.send(csv);
  });

  ownerRouter.get("/enquiries/test-template", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Respark ERP";
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet("Enquiry Test Data");

    worksheet.columns = [
      { header: "Client Name (Mandatory)", key: "name", width: 24 },
      { header: "Mobile No (Mandatory)", key: "phone", width: 22 },
      { header: "Email (Optional)", key: "email", width: 28 },
      { header: "Service Interested (Optional)", key: "service", width: 24 },
      { header: "Source (Optional)", key: "source", width: 18 },
      { header: "Priority (Optional: LOW/MEDIUM/HIGH)", key: "priority", width: 26 },
      { header: "Status (Optional: NEW/CONTACTED/INTERESTED/CONVERTED/LOST)", key: "status", width: 32 },
      { header: "Budget (Optional)", key: "budget", width: 18 },
      { header: "Follow Up Date (Optional YYYY-MM-DD)", key: "followUp", width: 26 },
      { header: "Notes (Optional)", key: "notes", width: 34 }
    ];

    const headerRow = worksheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell, colNumber) => {
      const isMandatory = colNumber <= 2;
      cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: isMandatory ? "FF1E3A8A" : "FF1E293B" }
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = {
        bottom: { style: "medium", color: { argb: "FF0F172A" } }
      };
    });

    const sampleRows = [
      ["Pooja Sharma", "9876543210", "pooja.sharma@example.com", "Hair Spa", "Instagram", "HIGH", "NEW", "2500", "2026-03-25", "Interested in bridal package inquiry"],
      ["Rahul Verma", "9812345678", "rahul.v@example.com", "Beard Trim & Styling", "Walk-in", "MEDIUM", "CONTACTED", "800", "2026-03-22", "Followed up via phone call"],
      ["Ananya Roy", "9898765432", "ananya.roy@example.com", "Facial & Glow Treatment", "Website", "HIGH", "INTERESTED", "3500", "2026-03-24", "Requested weekend appointment slot"],
      ["Vikas Kapoor", "9765432109", "vikas.k@example.com", "Men's Haircut", "Referral", "LOW", "NEW", "500", "", "Friend referred by existing member"],
      ["Simran Kaur", "9988776655", "simran.kaur@example.com", "Keratin Treatment", "Phone Call", "HIGH", "INTERESTED", "6000", "2026-03-26", "Asked about chemical-free keratin options"]
    ];

    sampleRows.forEach((rowValues) => {
      const row = worksheet.addRow(rowValues);
      row.height = 22;
      row.eachCell((cell) => {
        cell.font = { name: "Calibri", size: 10 };
        cell.alignment = { vertical: "middle" };
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
          right: { style: "thin", color: { argb: "FFE2E8F0" } }
        };
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="Enquiries_Test_Data.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  });

  ownerRouter.post("/enquiries/import", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "create"), memoryUpload.single("file"), async (req, res) => {
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
          if (rowValues.some((c) => c && c.length > 0)) {
            lines.push(rowValues);
          }
        });
      }
    } else {
      const csvString = req.file.buffer.toString("utf8");
      lines = csvString.split(/\r?\n/).map((line) => {
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
      }).filter((line) => line.length > 0 && line.some((col) => col.length > 0));
    }

    if (lines.length <= 1) {
      return res.status(400).json({ message: "Uploaded file is empty or missing headers" });
    }

    const headers = lines[0].map((h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, ""));
    const findHeaderIdx = (...keywords) => {
      return headers.findIndex((h) => keywords.some((k) => h.includes(k)));
    };

    const nameIdx = findHeaderIdx("name", "client", "clientname", "customer");
    const phoneIdx = findHeaderIdx("phone", "mobileno", "mobile", "contact", "number");
    const emailIdx = findHeaderIdx("email", "mail");
    const serviceIdx = findHeaderIdx("service", "serviceinterested", "interestedservice");
    const sourceIdx = findHeaderIdx("source", "channel", "leadsource");
    const priorityIdx = findHeaderIdx("priority");
    const statusIdx = findHeaderIdx("status");
    const budgetIdx = findHeaderIdx("budget", "amount", "price");
    const followUpIdx = findHeaderIdx("followup", "followupdate", "followupat");
    const notesIdx = findHeaderIdx("notes", "remark", "remarks", "comment");

    if (phoneIdx === -1 && nameIdx === -1) {
      return res.status(400).json({ message: "File must contain at least a 'Mobile No' or 'Client Name' column" });
    }

    const salonServices = await prisma.service.findMany({
      where: { salonId: req.salonId, isActive: true },
      select: { id: true, name: true }
    });
    const defaultServiceId = salonServices[0]?.id || null;

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    const validPriorities = ["LOW", "MEDIUM", "HIGH"];
    const validStatuses = ["NEW", "CONTACTED", "INTERESTED", "CONVERTED", "LOST"];

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i];
      const name = nameIdx !== -1 ? String(row[nameIdx] || "").trim() : "";
      const rawPhone = phoneIdx !== -1 ? String(row[phoneIdx] || "").trim() : "";
      const email = emailIdx !== -1 ? String(row[emailIdx] || "").trim() : "";
      const serviceName = serviceIdx !== -1 ? String(row[serviceIdx] || "").trim() : "";
      const source = sourceIdx !== -1 ? String(row[sourceIdx] || "").trim() : "Imported";
      const rawPriority = priorityIdx !== -1 ? String(row[priorityIdx] || "").trim().toUpperCase() : "MEDIUM";
      const rawStatus = statusIdx !== -1 ? String(row[statusIdx] || "").trim().toUpperCase() : "NEW";
      const rawBudget = budgetIdx !== -1 ? parseFloat(String(row[budgetIdx] || "").replace(/[^0-9.]/g, "")) : null;
      const rawFollowUp = followUpIdx !== -1 ? String(row[followUpIdx] || "").trim() : "";
      const notes = notesIdx !== -1 ? String(row[notesIdx] || "").trim() : "";

      if (!name && !rawPhone) {
        continue;
      }

      const cleanPhone = rawPhone.replace(/\D/g, "");
      if (!cleanPhone || cleanPhone.length < 7) {
        errorCount++;
        errors.push(`Row ${i + 1}: Invalid phone number (${rawPhone || "missing"})`);
        continue;
      }

      let matchedServiceId = null;
      if (serviceName) {
        const found = salonServices.find((s) => s.name.toLowerCase() === serviceName.toLowerCase());
        matchedServiceId = found ? found.id : defaultServiceId;
      } else {
        matchedServiceId = defaultServiceId;
      }

      const priority = validPriorities.includes(rawPriority) ? rawPriority : "MEDIUM";
      const status = validStatuses.includes(rawStatus) ? rawStatus : "NEW";
      const followUpAt = rawFollowUp && !isNaN(new Date(rawFollowUp).getTime()) ? new Date(rawFollowUp) : null;

      try {
        await prisma.enquiry.create({
          data: {
            salonId: req.salonId,
            name: name || `Client ${cleanPhone.slice(-4)}`,
            phone: cleanPhone,
            email: email || null,
            source: source || "Imported",
            interestedServiceId: matchedServiceId,
            budget: !isNaN(rawBudget) && rawBudget > 0 ? rawBudget : null,
            priority,
            status,
            followUpAt,
            notes: notes || null,
            createdByMembershipId: req.user.membershipId || null
          }
        });
        successCount++;
      } catch (err) {
        errorCount++;
        errors.push(`Row ${i + 1} (${name || cleanPhone}): ${err.message || "Failed to create"}`);
      }
    }

    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ENQUIRIES",
      action: "ENQUIRIES_IMPORTED",
      entityType: "Enquiry",
      entityId: req.salonId,
      summary: `Imported ${successCount} enquiries (${errorCount} errors)`
    }).catch(() => {});

    return res.json({
      message: `Successfully imported ${successCount} enquiry/enquiries (${errorCount} failed).`,
      successCount,
      errorCount,
      errors: errors.slice(0, 10)
    });
  });

  ownerRouter.get("/enquiries/:id", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    const row = await prisma.enquiry.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { interestedService: true, interestedBranch: true, assignedToMembership: { include: { user: true } }, convertedCustomer: true, convertedAppointment: true, followUps: { orderBy: { createdAt: "desc" } } }
    });
    if (!row) return res.status(404).json({ message: "Enquiry not found" });
    res.json(row);
  });

  ownerRouter.patch("/enquiries/:id", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), validate(schemas.enquiry), async (req, res) => {
    const row = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Enquiry not found" });
    const updated = await prisma.enquiry.update({
      where: { id: row.id },
      data: {
        name: req.body.name,
        phone: req.body.phone,
        email: req.body.email || null,
        source: req.body.source,
        interestedServiceId: req.body.interestedServiceId || null,
        interestedBranchId: req.body.interestedBranchId || null,
        budget: req.body.budget ?? null,
        priority: req.body.priority || "MEDIUM",
        assignedToMembershipId: req.body.assignedToMembershipId || null,
        followUpAt: toDate(req.body.followUpAt),
        notes: req.body.notes || null
      }
    });
    res.json(updated);
  });

  ownerRouter.patch("/enquiries/:id/status", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), validate(schemas.enquiryStatus), async (req, res) => {
    const row = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Enquiry not found" });
    const updated = await prisma.enquiry.update({ where: { id: row.id }, data: { status: req.body.status } });
    await prisma.enquiryFollowUp.create({
      data: {
        enquiryId: row.id,
        actorMembershipId: req.user.membershipId || null,
        note: req.body.note || `Status changed to ${req.body.status}`,
        status: req.body.status,
        completedAt: new Date()
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ENQUIRIES",
      action: "STATUS_UPDATED",
      entityType: "Enquiry",
      entityId: updated.id,
      summary: `Enquiry moved to ${updated.status}`
    });
    res.json(updated);
  });

  ownerRouter.post("/enquiries/:id/follow-up", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), validate(schemas.enquiryFollowUp), async (req, res) => {
    const enquiry = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });
    const row = await prisma.enquiryFollowUp.create({
      data: {
        enquiryId: enquiry.id,
        actorMembershipId: req.user.membershipId || null,
        note: req.body.note,
        status: req.body.status || null,
        dueAt: toDate(req.body.dueAt)
      }
    });
    if (req.body.dueAt) {
      await prisma.enquiry.update({ where: { id: enquiry.id }, data: { followUpAt: new Date(req.body.dueAt) } });
    }
    if (enquiry.email) {
      await attemptCustomerTemplateEmail({
        salonId: req.salonId,
        toEmail: enquiry.email,
        templateType: "enquiry_follow_up",
        context: {
          customer_name: enquiry.name,
          salon_name: "Skillify ERP"
        }
      });
    }
    res.status(201).json(row);
  });

  ownerRouter.post("/enquiries/:id/convert-to-customer", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), async (req, res) => {
    const enquiry = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });
    if (enquiry.phone) {
      const existing = await prisma.customer.findFirst({ where: { salonId: req.salonId, phone: enquiry.phone } });
      if (existing) return res.status(409).json({ message: "A customer with this phone already exists", customerId: existing.id });
    }
    const customer = await prisma.customer.create({
      data: {
        salonId: req.salonId,
        name: enquiry.name,
        phone: enquiry.phone,
        email: enquiry.email || null,
        source: `ENQUIRY:${enquiry.source}`,
        notes: enquiry.notes || null,
        branchId: req.body.branchId || enquiry.interestedBranchId || null
      }
    });
    await prisma.enquiry.update({
      where: { id: enquiry.id },
      data: { convertedCustomerId: customer.id, status: "CONVERTED" }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ENQUIRIES",
      action: "CONVERTED_TO_CUSTOMER",
      entityType: "Enquiry",
      entityId: enquiry.id,
      summary: `${enquiry.name} converted to customer`
    });
    res.status(201).json(customer);
  });

  ownerRouter.post("/enquiries/:id/convert-to-appointment", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), async (req, res) => {
    const enquiry = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });
    if (!req.body.customerId || !req.body.branchId || !req.body.startAt || !req.body.endAt) {
      return res.status(400).json({ message: "customerId, branchId, startAt and endAt are required" });
    }
    const appointment = await prisma.appointment.create({
      data: {
        salonId: req.salonId,
        customerId: req.body.customerId,
        branchId: req.body.branchId,
        primaryStaffUserId: req.body.primaryStaffUserId || null,
        createdByMembershipId: req.user.membershipId || null,
        title: enquiry.name,
        bookingChannel: "MANUAL",
        startAt: new Date(req.body.startAt),
        endAt: new Date(req.body.endAt),
        notes: enquiry.notes || null
      }
    });
    await prisma.enquiry.update({
      where: { id: enquiry.id },
      data: { convertedAppointmentId: appointment.id, status: "CONVERTED" }
    });
    res.status(201).json(appointment);
  });

};
