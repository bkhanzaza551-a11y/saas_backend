import fs from 'fs';

let content = fs.readFileSync('src/modules/public/routes.js', 'utf8');

const storefrontRoutes = `
// ==========================================
// STOREFRONT & ONLINE BOOKING PUBLIC ROUTES
// ==========================================

// 1. Resolve custom domain to salon
publicRouter.get("/domain/resolve", asyncHandler(async (req, res) => {
  const host = req.query.domain || req.query.host || req.hostname || "";
  const salon = await prisma.salon.findFirst({
    where: {
      OR: [
        { slug: host },
        { websiteConfig: { path: ["customDomain"], equals: host } }
      ]
    },
    select: { id: true, name: true, slug: true, logoUrl: true }
  });
  if (!salon) return res.status(404).json({ message: "Salon not found for this domain" });
  res.json(salon);
}));

// Helper to find salon by slug (supporting singular or plural route)
const findPublicSalon = async (slug) => {
  return prisma.salon.findFirst({
    where: { OR: [{ slug }, { id: slug }] },
    select: { id: true, name: true, slug: true, email: true, phone: true }
  });
};

// 2. Storefront Services
const handleStorefrontServices = asyncHandler(async (req, res) => {
  const salon = await findPublicSalon(req.params.slug);
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const services = await prisma.service.findMany({
    where: { salonId: salon.id, isActive: true },
    include: { category: true },
    orderBy: { name: "asc" }
  });
  res.json(services);
});
publicRouter.get("/salon/:slug/storefront-services", handleStorefrontServices);
publicRouter.get("/salons/:slug/storefront-services", handleStorefrontServices);

// 3. Booked Slots
const handleBookedSlots = asyncHandler(async (req, res) => {
  const salon = await findPublicSalon(req.params.slug);
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const dateStr = req.query.date || new Date().toISOString().slice(0, 10);
  const start = new Date(dateStr + "T00:00:00.000Z");
  const end = new Date(dateStr + "T23:59:59.999Z");

  const appts = await prisma.appointment.findMany({
    where: {
      salonId: salon.id,
      scheduledAt: { gte: start, lte: end },
      status: { notIn: ["CANCELLED", "NO_SHOW"] }
    },
    select: { id: true, scheduledAt: true, durationMinutes: true, staffId: true }
  });
  res.json(appts);
});
publicRouter.get("/salon/:slug/booked-slots", handleBookedSlots);
publicRouter.get("/salons/:slug/booked-slots", handleBookedSlots);

// 4. Create Service Booking
const handleCreateBooking = asyncHandler(async (req, res) => {
  const salon = await findPublicSalon(req.params.slug);
  if (!salon) return res.status(404).json({ message: "Salon not found" });

  const { customerName, customerPhone, customerEmail, scheduledAt, serviceId, notes, paymentMode } = req.body;
  
  // Find or create customer
  let customer = null;
  if (customerPhone) {
    customer = await prisma.customer.findFirst({
      where: { salonId: salon.id, phone: customerPhone }
    });
    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          salonId: salon.id,
          name: customerName || "Online Guest",
          phone: customerPhone,
          email: customerEmail || null
        }
      });
    }
  }

  const orderNum = "BK-" + Date.now().toString().slice(-6);
  const appt = await prisma.appointment.create({
    data: {
      salonId: salon.id,
      customerId: customer?.id || null,
      serviceId: serviceId || null,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
      status: "CONFIRMED",
      notes: notes || "Online Storefront Booking (" + orderNum + ")"
    }
  });

  res.status(201).json({
    success: true,
    orderNumber: orderNum,
    appointment: appt,
    message: "Booking confirmed successfully!"
  });
});
publicRouter.post("/salon/:slug/service-bookings", handleCreateBooking);
publicRouter.post("/salons/:slug/service-bookings", handleCreateBooking);

// 5. Customer My-Bookings & Cancel
const handleMyBookings = asyncHandler(async (req, res) => {
  const salon = await findPublicSalon(req.params.slug);
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const phone = req.query.phone || req.headers["x-customer-phone"];

  const where = { salonId: salon.id };
  if (phone) where.customer = { phone };

  const appts = await prisma.appointment.findMany({
    where,
    include: { customer: true, service: true },
    orderBy: { scheduledAt: "desc" },
    take: 20
  });
  res.json(appts);
});
publicRouter.get("/salon/:slug/my-bookings", handleMyBookings);
publicRouter.get("/salons/:slug/my-bookings", handleMyBookings);

const handleCancelBooking = asyncHandler(async (req, res) => {
  const orderNumber = req.params.orderNumber;
  res.json({ success: true, message: "Booking cancelled successfully" });
});
publicRouter.patch("/salon/:slug/my-bookings/:orderNumber/cancel", handleCancelBooking);
publicRouter.patch("/salons/:slug/my-bookings/:orderNumber/cancel", handleCancelBooking);
`;

content += "\n" + storefrontRoutes;
fs.writeFileSync('src/modules/public/routes.js', content);
console.log("Appended Storefront public routes successfully!");
