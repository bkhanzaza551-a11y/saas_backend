import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  campaign: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  campaignLog: { create: vi.fn(), findMany: vi.fn() },
  customer: { findMany: vi.fn(), findFirst: vi.fn() },
  salon: { findUnique: vi.fn() },
  salonSetting: { findFirst: vi.fn() },
  messageTemplate: { findMany: vi.fn() },
  appointment: { findFirst: vi.fn() },
  invoice: { findFirst: vi.fn() },
  order: { findFirst: vi.fn() },
  customerMembership: { findFirst: vi.fn() },
  membershipPack: { findFirst: vi.fn() }
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

const sendWhatsAppMock = vi.fn();
const sendWhatsAppBulkMock = vi.fn();
vi.mock("../src/lib/whatsappService.js", () => ({
  sendWhatsApp: sendWhatsAppMock,
  sendWhatsAppBulk: sendWhatsAppBulkMock
}));

const sendSmsMock = vi.fn();
vi.mock("../src/lib/smsService.js", () => ({ sendSms: sendSmsMock }));

const sendMailMock = vi.fn();
vi.mock("../src/lib/mailer.js", () => ({ sendMail: sendMailMock }));

// Keep the real renderTemplateText, stub only the DB-backed context resolver.
vi.mock("../src/lib/phase3.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveTemplateContext: vi.fn(async () => ({
      customer_name: "Priya Patel",
      salon_name: "Glow Beauty",
      price: "Rs.1499"
    }))
  };
});

const { registerCampaignRoutes } = await import("../src/modules/owner/phase3/campaigns.js");

const buildApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      userId: "owner-1",
      name: "Owner",
      systemRole: "SALON_USER",
      salonId: "salon-1",
      featureFlags: { campaigns: true },
      permissions: { campaigns: ["view", "create", "edit"] },
      ...overrides
    };
    req.salonId = req.user.salonId;
    next();
  });
  const router = express.Router();
  registerCampaignRoutes(router);
  app.use("/owner", router);
  return app;
};

describe("phase3 campaign test-send route", () => {
  beforeEach(() => {
    for (const model of Object.values(prismaMock)) {
      for (const fn of Object.values(model)) fn.mockReset?.();
    }
    sendWhatsAppMock.mockReset();
    sendSmsMock.mockReset();
    sendMailMock.mockReset();
    prismaMock.customer.findFirst.mockReset();
  });

  it("rejects an unsupported channel", async () => {
    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "SOCIAL_BANNER", testNumber: "919999999999", message: "Hi" });
    expect(res.status).toBe(400);
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });

  it("requires a test number", async () => {
    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "WHATSAPP", message: "Hi" });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("testNumber is required");
  });

  it("requires a message", async () => {
    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "WHATSAPP", testNumber: "919999999999" });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Message is required");
  });

  it("validates the email address for EMAIL channel", async () => {
    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "EMAIL", testNumber: "not-an-email", message: "Hi" });
    expect(res.status).toBe(400);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("blocks the route when the campaigns feature flag is disabled", async () => {
    const res = await request(buildApp({ featureFlags: { campaigns: false } }))
      .post("/owner/campaigns/test")
      .send({ channel: "WHATSAPP", testNumber: "919999999999", message: "Hi" });
    expect(res.status).toBe(403);
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });

  it("blocks the route without create permission", async () => {
    const res = await request(buildApp({ permissions: { campaigns: ["view"] } }))
      .post("/owner/campaigns/test")
      .send({ channel: "WHATSAPP", testNumber: "919999999999", message: "Hi" });
    expect(res.status).toBe(403);
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });

  it("renders named and double-bracket variables before sending WhatsApp", async () => {
    sendWhatsAppMock.mockResolvedValue({ success: true, messageId: "wamid.1" });

    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({
        channel: "WHATSAPP",
        testNumber: "919999999999",
        message: "Hi {{customer_name}}, flat {{price}} only",
        imageUrl: "https://cdn.example.com/offer.png"
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    const arg = sendWhatsAppMock.mock.calls[0][0];
    expect(arg.salonId).toBe("salon-1");
    expect(arg.to).toBe("919999999999");
    expect(arg.message).toBe("Hi Priya Patel, flat Rs.1499 only");
    expect(arg.imageUrl).toBe("https://cdn.example.com/offer.png");
    expect(res.body.renderedMessage).toBe("Hi Priya Patel, flat Rs.1499 only");
  });

  it("links the customer when the test number belongs to the salon", async () => {
    prismaMock.customer.findFirst.mockResolvedValue({ id: "cust-7" });
    sendWhatsAppMock.mockResolvedValue({ success: true, messageId: "wamid.2" });

    await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "WHATSAPP", testNumber: "919999999999", message: "Hi" });

    expect(prismaMock.customer.findFirst).toHaveBeenCalled();
    expect(sendWhatsAppMock.mock.calls[0][0].customerId).toBe("cust-7");
  });

  it("survives a customer lookup failure", async () => {
    prismaMock.customer.findFirst.mockRejectedValue(new Error("db down"));
    sendSmsMock.mockResolvedValue({ success: true, messageId: "sms-1" });

    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "SMS", testNumber: "919999999999", message: "Hi" });

    expect(res.status).toBe(200);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
  });

  it("returns 502 when the WhatsApp provider fails", async () => {
    sendWhatsAppMock.mockResolvedValue({ success: false, error: "Template not approved" });

    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "WHATSAPP", testNumber: "919999999999", message: "Hi" });

    expect(res.status).toBe(502);
    expect(res.body.message).toBe("Template not approved");
  });

  it("sends the test SMS through the configured provider", async () => {
    sendSmsMock.mockResolvedValue({ success: true, messageId: "sms-2" });

    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "SMS", testNumber: "919999999999", message: "Hi {{customer_name}}" });

    expect(res.status).toBe(200);
    expect(sendSmsMock).toHaveBeenCalledWith({
      salonId: "salon-1",
      to: "919999999999",
      message: "Hi Priya Patel"
    });
  });

  it("returns 502 when the SMS provider fails", async () => {
    sendSmsMock.mockResolvedValue({ success: false, error: "DND registry blocked" });

    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "SMS", testNumber: "919999999999", message: "Hi" });

    expect(res.status).toBe(502);
    expect(res.body.message).toBe("DND registry blocked");
  });

  it("sends the test email without looking up a customer", async () => {
    sendMailMock.mockResolvedValue({ messageId: "mail-1" });

    const res = await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "EMAIL", testNumber: "owner@example.com", message: "Hi {{customer_name}}" });

    expect(res.status).toBe(200);
    expect(prismaMock.customer.findFirst).not.toHaveBeenCalled();
    const arg = sendMailMock.mock.calls[0][0];
    expect(arg.to).toBe("owner@example.com");
    expect(arg.text).toBe("Hi Priya Patel");
    expect(arg.html).toContain("Hi Priya Patel");
  });

  it("does not create a campaign, campaign log or whatsapp log for a test send", async () => {
    sendWhatsAppMock.mockResolvedValue({ success: true, messageId: "wamid.3" });

    await request(buildApp())
      .post("/owner/campaigns/test")
      .send({ channel: "WHATSAPP", testNumber: "919999999999", message: "Hi" });

    expect(prismaMock.campaign.create).not.toHaveBeenCalled();
    expect(prismaMock.campaign.update).not.toHaveBeenCalled();
    expect(prismaMock.campaignLog.create).not.toHaveBeenCalled();
  });
});
