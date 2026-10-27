import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomInt } from "crypto";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma";
import { sendPasswordResetEmail } from "../lib/mailer";

const router = express.Router();

const googleClient = new OAuth2Client();

function issueTokens(userId: string) {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: "15m" },
  );
  const refreshToken = jwt.sign(
    { userId },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: "30d" },
  );
  return { accessToken, refreshToken };
}

router.post("/signup", async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: "Name, email and password required" });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "User already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, name, passwordHash },
  });

  const { accessToken, refreshToken } = issueTokens(user.id);

  res
    .status(201)
    .json({
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, isPremium: user.isPremium, avatarUrl: user.avatarUrl },
    });
});


router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const { accessToken, refreshToken } = issueTokens(user.id);

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, name: user.name, isPremium: user.isPremium, avatarUrl: user.avatarUrl },
  });
});

router.post("/google", async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: "idToken required" });
  }

  const audience = process.env.GOOGLE_WEB_CLIENT_ID;
  if (!audience) {
    return res.status(500).json({ error: "Google sign-in is not configured" });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch (err) {
    console.warn("Google ID token verification failed:", (err as Error).message);
    return res.status(401).json({ error: "Invalid Google token" });
  }

  if (!payload?.email) {
    return res.status(401).json({ error: "Invalid Google token" });
  }

  // Never trust an unverified email: we link Google identities to existing
  // password accounts by email below, so an unverified one would let anyone
  // take over an account just by claiming its address.
  if (!payload.email_verified) {
    return res.status(403).json({ error: "Your Google email address is not verified" });
  }

  const email: string = payload.email!;
  const { sub: googleId, name, picture } = payload;

  let user = await prisma.user.findUnique({ where: { googleId } });
  let isNewUser = false;

  if (!user) {
    // Link to an existing password account with the same email, or create a new one.
    user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId, avatarUrl: user.avatarUrl ?? picture ?? null },
      });
    } else {
      user = await prisma.user.create({
        data: { email, name: name || email.split("@")[0] || "Lumora user", googleId, avatarUrl: picture ?? null },
      });
      isNewUser = true;
    }
  }

  const { accessToken, refreshToken } = issueTokens(user.id);

  res.json({
    accessToken,
    refreshToken,
    isNewUser,
    user: { id: user.id, email: user.email, name: user.name, isPremium: user.isPremium, avatarUrl: user.avatarUrl },
  });
});

// POST /auth/refresh — swaps a valid refresh token for a new token pair, so
// the app can keep a session alive past the 15-minute access token.
router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken !== "string" || !refreshToken) {
    return res.status(400).json({ error: "refreshToken required" });
  }

  let userId: string;
  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as { userId?: unknown };
    if (typeof payload.userId !== "string") throw new Error("no userId");
    userId = payload.userId;
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please log in again" });
  }

  // A deleted account must not be able to mint new tokens.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    return res.status(401).json({ error: "Your session has expired. Please log in again" });
  }

  res.json(issueTokens(user.id));
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email required" });
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Always respond the same way whether or not the account exists, so
  // this endpoint can't be used to find out which emails are registered.
  if (user && user.passwordHash) {
    const code = randomInt(100000, 1000000).toString();
    const resetCodeHash = await bcrypt.hash(code, 10);
    const resetCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { resetCodeHash, resetCodeExpiresAt },
    });

    try {
      await sendPasswordResetEmail(email, code);
    } catch (err) {
      // Don't let an email-provider failure change this endpoint's
      // response — that would leak whether the account exists. The code
      // is already saved; log the failure server-side for debugging.
      console.error("[forgot-password] Failed to send reset email:", err);
    }
  }

  res.json({ message: "If that email is registered, a reset code has been sent." });
});

router.post("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;

  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: "Email, code and new password required" });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.resetCodeHash || !user.resetCodeExpiresAt) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }

  if (user.resetCodeExpiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }

  const validCode = await bcrypt.compare(code, user.resetCodeHash);
  if (!validCode) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, resetCodeHash: null, resetCodeExpiresAt: null },
  });

  const { accessToken, refreshToken } = issueTokens(updated.id);

  res.json({
    accessToken,
    refreshToken,
    user: { id: updated.id, email: updated.email, name: updated.name, isPremium: updated.isPremium, avatarUrl: updated.avatarUrl },
  });
});

export default router;
