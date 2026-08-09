import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const posts = await prisma.post.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { name: true } },
      postLikes: { where: { userId: req.userId! }, select: { id: true } },
      _count: { select: { postLikes: true, comments: true } },
    },
    take: 50,
  });

  res.json(
    posts.map((p) => ({
      id: p.id,
      content: p.content,
      tag: p.tag,
      likes: p._count.postLikes,
      commentCount: p._count.comments,
      likedByMe: p.postLikes.length > 0,
      createdAt: p.createdAt,
      authorName: p.user.name,
    })),
  );
});

router.post("/", requireAuth, async (req, res) => {
  const { content, tag } = req.body;
  if (!content?.trim())
    return res.status(400).json({ error: "Content required" });

  const post = await prisma.post.create({
    data: {
      userId: req.userId!,
      content: content.trim(),
      tag: tag || "General",
    },
    include: { user: { select: { name: true } } },
  });
  res.status(201).json({
    id: post.id,
    content: post.content,
    tag: post.tag,
    likes: 0,
    likedByMe: false,
    createdAt: post.createdAt,
    authorName: post.user.name,
  });
});

router.post("/:id/like", requireAuth, async (req, res) => {
  const postId = String(req.params.id);
  const userId = req.userId!;

  const existing = await prisma.postLike.findUnique({
    where: { userId_postId: { userId, postId } },
  });

  if (existing) {
    // Already liked — unlike it (toggle off)
    await prisma.postLike.delete({ where: { id: existing.id } });
  } else {
    // Not liked yet — like it
    await prisma.postLike.create({ data: { userId, postId } });
  }

  const likeCount = await prisma.postLike.count({ where: { postId } });
  res.json({ likes: likeCount, likedByMe: !existing });
});

router.get("/:id/comments", requireAuth, async (req, res) => {
  const comments = await prisma.comment.findMany({
    where: { postId: String(req.params.id) },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { name: true } } },
  });
  res.json(
    comments.map((c) => ({
      id: c.id,
      content: c.content,
      createdAt: c.createdAt,
      authorName: c.user.name,
    })),
  );
});

router.post("/:id/comments", requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim())
    return res.status(400).json({ error: "Content required" });

  const comment = await prisma.comment.create({
    data: {
      postId: String(req.params.id),
      userId: req.userId!,
      content: content.trim(),
    },
    include: { user: { select: { name: true } } },
  });
  res.status(201).json({
    id: comment.id,
    content: comment.content,
    createdAt: comment.createdAt,
    authorName: comment.user.name,
  });
});

export default router;
