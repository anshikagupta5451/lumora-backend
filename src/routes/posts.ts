import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

const router = express.Router();

const categories = [
  "General",
  "Products",
  "My Story",
  "Study Hub",
  "Challenges",
];

router.get("/", requireAuth, async (req, res) => {
  const { category } = req.query;

  const posts = await prisma.post.findMany({
    where: category && category !== "All" ? { category: String(category) } : {},
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
      userId: p.userId,
      title: p.title,
      content: p.content,
      category: p.category,
      tags: p.tags,
      likes: p._count.postLikes,
      commentCount: p._count.comments,
      likedByMe: p.postLikes.length > 0,
      createdAt: p.createdAt,
      authorName: p.user.name,
    })),
  );
});

// IMPORTANT: this route must come before GET /:id, otherwise "mine" gets
// treated as a post ID and this handler is never reached.
router.get("/mine/all", requireAuth, async (req, res) => {
  const posts = await prisma.post.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { name: true } },
      postLikes: { where: { userId: req.userId! }, select: { id: true } },
      _count: { select: { postLikes: true, comments: true } },
    },
  });

  res.json(
    posts.map((p) => ({
      id: p.id,
      userId: p.userId,
      title: p.title,
      content: p.content,
      category: p.category,
      tags: p.tags,
      likes: p._count.postLikes,
      commentCount: p._count.comments,
      likedByMe: p.postLikes.length > 0,
      createdAt: p.createdAt,
      authorName: p.user.name,
    })),
  );
});

router.get("/:id", requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({
    where: { id: String(req.params.id) },
    include: {
      user: { select: { name: true } },
      postLikes: { where: { userId: req.userId! }, select: { id: true } },
      _count: { select: { postLikes: true, comments: true } },
    },
  });
  if (!post) return res.status(404).json({ error: "Post not found" });

  res.json({
    id: post.id,
    userId: post.userId,
    title: post.title,
    content: post.content,
    category: post.category,
    tags: post.tags,
    likes: post._count.postLikes,
    commentCount: post._count.comments,
    likedByMe: post.postLikes.length > 0,
    createdAt: post.createdAt,
    authorName: post.user.name,
  });
});

router.post("/", requireAuth, async (req, res) => {
  const { title, content, category, tags } = req.body;
  if (!content?.trim())
    return res.status(400).json({ error: "Content required" });

  const post = await prisma.post.create({
    data: {
      userId: req.userId!,
      title: title?.trim() || null,
      content: content.trim(),
      category: categories.includes(category) ? category : "General",
      tags: Array.isArray(tags) ? tags : [],
    },
    include: { user: { select: { name: true } } },
  });
  res.status(201).json({
    id: post.id,
    userId: post.userId,
    title: post.title,
    content: post.content,
    category: post.category,
    tags: post.tags,
    likes: 0,
    commentCount: 0,
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

  try {
    if (existing) {
      await prisma.postLike.delete({ where: { id: existing.id } });
    } else {
      await prisma.postLike.create({ data: { userId, postId } });
    }
  } catch (err: any) {}

  const likeCount = await prisma.postLike.count({ where: { postId } });
  const stillLiked = await prisma.postLike.findUnique({
    where: { userId_postId: { userId, postId } },
  });

  res.json({ likes: likeCount, likedByMe: Boolean(stillLiked) });
});

// Comments — threaded, anonymous-aware
router.get("/:id/comments", requireAuth, async (req, res) => {
  const comments = await prisma.comment.findMany({
    where: { postId: String(req.params.id) },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, name: true } } },
  });

  res.json(
    comments.map((c) => ({
      id: c.id,
      content: c.content,
      parentCommentId: c.parentCommentId,
      createdAt: c.createdAt,
      authorId: c.isAnonymous ? null : c.userId,
      authorName: c.isAnonymous ? "Anonymous" : c.user.name,
    })),
  );
});

router.post("/:id/comments", requireAuth, async (req, res) => {
  const { content, parentCommentId, isAnonymous } = req.body;
  if (!content?.trim())
    return res.status(400).json({ error: "Content required" });

  const comment = await prisma.comment.create({
    data: {
      postId: String(req.params.id),
      userId: req.userId!,
      content: content.trim(),
      parentCommentId: parentCommentId || null,
      isAnonymous: Boolean(isAnonymous),
    },
    include: { user: { select: { id: true, name: true } } },
  });
  res.status(201).json({
    id: comment.id,
    content: comment.content,
    parentCommentId: comment.parentCommentId,
    createdAt: comment.createdAt,
    authorId: comment.isAnonymous ? null : comment.userId,
    authorName: comment.isAnonymous ? "Anonymous" : comment.user.name,
  });
});

export default router;
