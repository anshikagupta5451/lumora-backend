import cron from "node-cron";
import { Expo } from "expo-server-sdk";
import { prisma } from "../lib/prisma";

const expo = new Expo();

export function startStreakReminderJob() {
  cron.schedule("0 20 * * *", async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const users = await prisma.user.findMany({
      where: { pushToken: { not: null } },
      select: { id: true, pushToken: true },
    });

    const messages = [];
    for (const user of users) {
      const checkedInToday = await prisma.checkIn.findFirst({
        where: { userId: user.id, createdAt: { gte: startOfDay } },
      });
      if (
        !checkedInToday &&
        user.pushToken &&
        Expo.isExpoPushToken(user.pushToken)
      ) {
        messages.push({
          to: user.pushToken,
          sound: "default" as const,
          title: "Don't lose your streak! 🔥",
          body: "You haven't checked in today — takes 10 seconds.",
        });
      }
    }

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        console.error("Push send error:", err);
      }
    }
  });
}
