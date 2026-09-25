import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Load directly from the file to bypass DB for testing
import * as smsService from './src/lib/smsService.js';

// Since smsloginSend is not exported, we can temporarily hack it or just export it.
// Wait, I can just create a salonSetting for this salon.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testSMS() {
  try {
    const salon = await prisma.salon.findFirst();
    
    console.log("Upserting settings for salon:", salon.id);
    await prisma.salonSetting.upsert({
      where: { salonId_branchId: { salonId: salon.id, branchId: null } },
      update: { smsSettings: { gatewayProvider: 'smslogin' } },
      create: { salonId: salon.id, smsSettings: { gatewayProvider: 'smslogin' } }
    }).catch(e => {
        // if unique constraint is different, just create or update
        return prisma.salonSetting.create({
            data: { salonId: salon.id, smsSettings: { gatewayProvider: 'smslogin' } }
        }).catch(e2 => console.log("Already exists or error"));
    });

    console.log("Sending OTP to +917747911593...");
    const response = await smsService.sendSms({
      salonId: salon.id,
      to: '+917747911593',
      message: 'Your SalonNest verification OTP is 123456. Do not share this with anyone.',
    });
    
    console.log("SMS API Response:", response);
  } catch (err) {
    console.error("Test Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

testSMS();
