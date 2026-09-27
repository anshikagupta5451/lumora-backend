import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "./requireAuth";

// Admins are listed by login email in ADMIN_EMAILS (comma-separated) in
// the backend .env, so granting access needs no migration or UI — and
// nobody can make themselves an admin from the app.
export function isAdminEmail(email: string | null | undefined) {
  if (!email) return false;
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { email: true },
      });
      if (!isAdminEmail(user?.email)) {
        return res.status(403).json({ error: "Admins only" });
      }
      next();
    } catch (err) {
      next(err);
    }
  });
}
