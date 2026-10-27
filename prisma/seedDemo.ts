// Demo data for showing Lumora: a catalog top-up, a few community members
// with posts, reviews and check-ins, and one fully set-up account to log in
// with. Everything user-owned belongs to an @demo.lumora.app user, so it can
// be removed without touching real accounts.
//
//   npm run seed:demo     replace all demo data (safe to re-run)
//   npm run unseed:demo   remove demo users and everything they own
//
// Catalog products added here stay on removal: real users may have shelved
// or reviewed them by then.
import bcrypt from "bcrypt";
import { prisma } from "../src/lib/prisma";
import { awardBounty } from "../src/lib/bounties";

const DEMO_DOMAIN = "@demo.lumora.app";
const DEMO_PASSWORD = "Demo@1234";

const day = 24 * 60 * 60 * 1000;
function daysAgo(n: number, hour = 9, minute = 0) {
  const d = new Date(Date.now() - n * day);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function daysFromNow(n: number) {
  return new Date(Date.now() + n * day);
}

const catalog = [
  { name: "Niacinamide 5% Face Serum", brand: "Minimalist", category: "serum", ingredients: ["niacinamide", "zinc", "hyaluronic acid"], price: 599, isPromoted: true },
  { name: "Salicylic Acid 2% Face Serum", brand: "Minimalist", category: "serum", ingredients: ["salicylic acid", "lha"], price: 549 },
  { name: "Retinol 0.3% Face Serum", brand: "Minimalist", category: "serum", ingredients: ["retinol", "squalane"], price: 649 },
  { name: "Sepicalm 3% Moisturizer", brand: "Minimalist", category: "moisturizer", ingredients: ["oat extract", "ceramides", "squalane"], price: 349 },
  { name: "Vitamin C + E Super Bright Moisturizer", brand: "Dot & Key", category: "moisturizer", ingredients: ["vitamin c", "vitamin e", "fragrance"], price: 495 },
  { name: "Watermelon Cooling Sunscreen SPF 50", brand: "Dot & Key", category: "sunscreen", ingredients: ["zinc oxide", "hyaluronic acid", "fragrance"], price: 445 },
  { name: "Green Tea Pore Cleansing Face Wash", brand: "Plum", category: "cleanser", ingredients: ["green tea", "glycolic acid"], price: 345 },
  { name: "Sun Expert Ultra Matte SPF 50", brand: "Lakme", category: "sunscreen", ingredients: ["avobenzone", "octocrylene", "alcohol denat"], price: 399 },
  { name: "Hydro Boost Water Gel", brand: "Neutrogena", category: "moisturizer", ingredients: ["hyaluronic acid", "glycerin"], price: 999 },
  { name: "Gentle Skin Cleanser", brand: "Cetaphil", category: "cleanser", ingredients: ["glycerin", "niacinamide", "panthenol"], price: 425 },
  { name: "Cicaplast Baume B5+", brand: "La Roche-Posay", category: "moisturizer", ingredients: ["panthenol", "madecassoside", "shea butter"], price: 1350 },
  { name: "Ceramide & Hyaluronic Moisturiser", brand: "Re'equil", category: "moisturizer", ingredients: ["ceramides", "hyaluronic acid"], price: 595 },
  { name: "Exfoliating Serum 10% AHA", brand: "Deconstruct", category: "exfoliant", ingredients: ["glycolic acid", "lactic acid"], price: 499 },
  { name: "Hydrating Face Wash", brand: "Foxtale", category: "cleanser", ingredients: ["hyaluronic acid", "ceramides"], price: 299 },
  { name: "Tea Tree Spot Gel", brand: "The Body Shop", category: "active", ingredients: ["tea tree oil", "salicylic acid", "alcohol denat"], price: 795 },
  { name: "Under Eye Cream with Caffeine", brand: "mCaffeine", category: "active", ingredients: ["caffeine", "peptides", "vitamin e"], price: 449 },
];

type DemoUser = {
  key: string;
  name: string;
  skinType: string;
  concerns: string[];
  sensitivities: string[];
  goals: string[];
  monthlyBudget: number;
  isPremium?: boolean;
};

// `key` builds the email: <key>@demo.lumora.app
const users: DemoUser[] = [
  { key: "demo", name: "Aanya Sharma", skinType: "combination", concerns: ["acne", "pigmentation", "large pores"], sensitivities: ["fragrance"], goals: ["clear skin", "even tone"], monthlyBudget: 2000 },
  { key: "riya", name: "Riya Mehta", skinType: "oily", concerns: ["acne", "large pores"], sensitivities: ["none that i know of"], goals: ["oil control", "clear skin"], monthlyBudget: 1500 },
  { key: "kabir", name: "Kabir Singh", skinType: "dry", concerns: ["dryness", "dullness"], sensitivities: ["alcohol"], goals: ["hydration"], monthlyBudget: 1200 },
  { key: "meera", name: "Meera Iyer", skinType: "sensitive", concerns: ["dryness", "fine lines"], sensitivities: ["fragrance", "essential oils"], goals: ["anti-aging", "hydration"], monthlyBudget: 3000, isPremium: true },
  { key: "ishaan", name: "Ishaan Verma", skinType: "oily", concerns: ["acne", "pigmentation"], sensitivities: ["sulfates"], goals: ["clear skin"], monthlyBudget: 1000 },
  { key: "zoya", name: "Zoya Khan", skinType: "combination", concerns: ["pigmentation", "dullness"], sensitivities: ["none that i know of"], goals: ["even tone"], monthlyBudget: 2500 },
  { key: "arjun", name: "Arjun Nair", skinType: "normal", concerns: ["dullness"], sensitivities: ["none that i know of"], goals: ["anti-aging"], monthlyBudget: 1800 },
  { key: "sana", name: "Sana Kapoor", skinType: "dry", concerns: ["dryness", "pigmentation"], sensitivities: ["fragrance"], goals: ["hydration", "even tone"], monthlyBudget: 2200 },
];

// [author, product name, rating, title, comment, daysAgo]
const reviews: [string, string, number, string, string, number][] = [
  ["riya", "Niacinamide 5% Face Serum", 5, "Pores look smaller", "Six weeks in and my T-zone is way less shiny by 3 pm. No purging.", 21],
  ["ishaan", "Niacinamide 5% Face Serum", 4, "Solid daily serum", "Helped with post-acne marks. Slightly tacky if you use too much.", 15],
  ["zoya", "Niacinamide 5% Face Serum", 4, "Gentle and works", "Evened out my tone a bit. Pairs fine with sunscreen.", 9],
  ["demo", "Niacinamide 5% Face Serum", 5, "Repurchasing", "My go-to for oily days. Layers well under the Re'equil moisturiser.", 6],
  ["riya", "Salicylic Acid 2% Face Serum", 5, "Saved my chin", "Used it 3 nights a week; closed comedones gone in a month.", 30],
  ["ishaan", "Salicylic Acid 2% Face Serum", 4, "Works, start slow", "Dried me out when I used it daily. Every other night is the sweet spot.", 12],
  ["kabir", "Salicylic Acid 2% Face Serum", 2, "Too drying for me", "Flaky patches after a week. Probably better for oily skin.", 18],
  ["meera", "Retinol 0.3% Face Serum", 4, "Beginner friendly", "Mild tingling the first week, then fine. Always with sunscreen.", 25],
  ["arjun", "Retinol 0.3% Face Serum", 5, "Skin looks smoother", "Two months in, fine lines around the eyes are softer.", 40],
  ["kabir", "Hydro Boost Water Gel", 5, "Instant drink of water", "Absorbs fast, no grease, great before sunscreen.", 11],
  ["sana", "Hydro Boost Water Gel", 3, "Not enough for winter", "Lovely in summer, but my dry skin needs something richer now.", 7],
  ["meera", "Cicaplast Baume B5+", 5, "Barrier rescue", "Calmed redness after an over-exfoliation disaster within two days.", 33],
  ["sana", "Cicaplast Baume B5+", 5, "Worth the price", "Thick but my dry cheeks love it overnight.", 14],
  ["kabir", "Gentle Skin Cleanser", 4, "Doesn't strip", "Skin feels clean, not tight. Boring in the best way.", 20],
  ["meera", "Gentle Skin Cleanser", 5, "Sensitive-skin safe", "Only cleanser that never stings for me.", 26],
  ["zoya", "Watermelon Cooling Sunscreen SPF 50", 4, "No white cast", "Pleasant to wear daily; scent is noticeable though.", 10],
  ["sana", "Watermelon Cooling Sunscreen SPF 50", 2, "Scent irritated me", "Fragrance made my eyes water. Texture is nice otherwise.", 16],
  ["riya", "Sun Expert Ultra Matte SPF 50", 4, "Truly matte", "Keeps oil down all day in Mumbai humidity.", 8],
  ["kabir", "Sun Expert Ultra Matte SPF 50", 2, "Stings on dry skin", "Felt alcohol-y and tight on my dry skin.", 13],
  ["zoya", "Exfoliating Serum 10% AHA", 4, "Glow is real", "Twice a week at night; dull patches brighter in 3 weeks.", 19],
  ["demo", "Exfoliating Serum 10% AHA", 4, "Use it at night only", "Brightening is noticeable. Never skip SPF the next day.", 4],
  ["ishaan", "Tea Tree Spot Gel", 3, "Okay for spots", "Shrinks small pimples overnight, does little for big ones.", 22],
  ["riya", "Green Tea Pore Cleansing Face Wash", 4, "Fresh and clean", "Nice morning wash for oily skin.", 27],
  ["arjun", "Under Eye Cream with Caffeine", 3, "Mild results", "Slight de-puffing in the morning, dark circles unchanged.", 17],
  ["zoya", "Ceramide & Hyaluronic Moisturiser", 5, "Light but hydrating", "Perfect for combination skin, no breakouts.", 5],
  ["meera", "Sepicalm 3% Moisturizer", 5, "Calms everything", "Redness down noticeably; fragrance-free which I need.", 3],
];

// [author, category, title, content, tags, daysAgo]
const posts: [string, string, string, string, string[], number][] = [
  ["riya", "My Story", "3 months of fighting hormonal acne", "Sharing my progress: switched to a 2% salicylic serum three nights a week, niacinamide in the morning, and stopped picking (hardest part!). Chin breakouts went from constant to maybe one a fortnight. Patience is everything.", ["acne", "progress"], 2],
  ["meera", "Study Hub", "Why you shouldn't mix retinol and AHAs on the same night", "Both increase cell turnover and lower your barrier's tolerance. Alternate nights instead: retinol Mon/Thu, AHA Tue/Fri, rest nights in between with just a barrier cream. Your skin will thank you.", ["retinol", "aha", "layering"], 3],
  ["zoya", "Products", "Sunscreens with no white cast on medium skin?", "Looking for something that doesn't leave a grey cast on wheatish skin. Currently trying the Dot & Key watermelon one. What's worked for you?", ["sunscreen", "recommendations"], 1],
  ["kabir", "General", "Winter dryness tips for guys who hate skincare", "Three steps, that's it: gentle cleanser, a gel moisturiser in the morning, something thicker at night. Took me ten minutes to set up and my face stopped flaking.", ["dry skin", "beginner"], 5],
  ["sana", "Challenges", "30-day SPF challenge: day 12", "Reapplied at lunch every day this week. Noticing my pigmentation isn't getting darker the way it usually does in October. Anyone else joining?", ["spf", "challenge"], 0],
  ["arjun", "Study Hub", "Niacinamide percentages: is more better?", "Studies mostly use 2–5%. 10% isn't twice as good and can irritate some people. If 5% works for you, there's no reason to go higher.", ["niacinamide", "science"], 8],
  ["ishaan", "Products", "Budget routine under ₹1000 that actually works", "Cetaphil cleanser, Minimalist niacinamide, Lakme matte SPF. Total around ₹1400 but each lasts 2+ months, so under ₹1000 a month.", ["budget", "routine"], 6],
  ["demo", "My Story", "First week using Lumora's daily brief", "Liked that it told me *why*: UV index 9 so reapply SPF, humidity high so skip the heavy cream. Small thing but I actually followed it.", ["daily brief"], 4],
];

// [post index, author, content, daysAgo]
const comments: [number, string, string, number][] = [
  [0, "ishaan", "Same experience with not picking. It's 80% of the battle.", 2],
  [0, "zoya", "How long before you saw the first change?", 1],
  [0, "riya", "About 4 weeks for fewer new ones, 8 for the marks to fade.", 1],
  [1, "demo", "This is so useful, I was doing both on Sundays 😅", 3],
  [1, "arjun", "Bookmarked. Rest nights are underrated.", 2],
  [2, "sana", "Re'equil's sheer zinc one works on my skin tone.", 1],
  [2, "riya", "Lakme Sun Expert matte, zero cast for me.", 0],
  [3, "meera", "Love this. Simple routines are the ones people stick to.", 4],
  [4, "demo", "Joining from tomorrow!", 0],
  [5, "meera", "Exactly. 5% is the sweet spot for my sensitive skin.", 7],
  [6, "kabir", "Saving this for my brother.", 5],
  [7, "zoya", "The reasons are my favourite part too.", 3],
];

// [post index, likers]
const likes: [number, string[]][] = [
  [0, ["ishaan", "zoya", "meera", "demo", "sana"]],
  [1, ["demo", "arjun", "zoya", "riya", "sana", "kabir"]],
  [2, ["sana", "riya"]],
  [3, ["meera", "arjun", "ishaan"]],
  [4, ["demo", "zoya"]],
  [5, ["meera", "riya", "demo"]],
  [6, ["kabir", "riya", "zoya", "demo"]],
  [7, ["zoya", "riya", "meera"]],
];

const moodNotes = [
  "Skin felt calm today",
  "Small breakout on chin, didn't pick it!",
  "Slept well, glowy morning",
  "Bit oily by evening",
  "Remembered to reapply SPF",
  null,
  "Tried the new serum, no reaction",
];

async function removeDemo() {
  const demoUsers = await prisma.user.findMany({
    where: { email: { endsWith: DEMO_DOMAIN } },
    select: { id: true },
  });
  const ids = demoUsers.map((u) => u.id);
  if (ids.length === 0) return 0;
  const mine = { userId: { in: ids } };
  const demoPosts = { post: { userId: { in: ids } } };

  await prisma.$transaction([
    prisma.postLike.deleteMany({ where: { OR: [mine, demoPosts] } }),
    prisma.bookmark.deleteMany({ where: { OR: [mine, demoPosts] } }),
    prisma.report.deleteMany({ where: { OR: [mine, demoPosts] } }),
    // Replies first: a parent comment can't go while replies point at it.
    prisma.comment.deleteMany({ where: { OR: [mine, demoPosts], parentCommentId: { not: null } } }),
    prisma.comment.deleteMany({ where: { OR: [mine, demoPosts] } }),
    prisma.post.deleteMany({ where: mine }),
    prisma.review.deleteMany({ where: mine }),
    prisma.checkIn.deleteMany({ where: mine }),
    prisma.recommendation.deleteMany({ where: mine }),
    prisma.routineStep.deleteMany({ where: { routine: mine } }),
    prisma.routine.deleteMany({ where: mine }),
    prisma.userProduct.deleteMany({ where: mine }),
    prisma.bountyCompletion.deleteMany({ where: mine }),
    prisma.faceScan.deleteMany({ where: mine }),
    prisma.skinProfile.deleteMany({ where: mine }),
    prisma.user.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return ids.length;
}

async function seed() {
  // Catalog top-up: add only what's missing, so re-runs don't duplicate.
  let added = 0;
  for (const p of catalog) {
    const exists = await prisma.product.findFirst({ where: { name: p.name, brand: p.brand } });
    if (!exists) {
      await prisma.product.create({ data: { imageUrl: null, ...p } });
      added++;
    }
  }
  console.log(`Catalog: ${added} products added (${catalog.length - added} already there)`);

  const products = await prisma.product.findMany({ select: { id: true, name: true } });
  const productId = (name: string) => {
    const p = products.find((x) => x.name === name);
    if (!p) throw new Error(`Demo seed: product "${name}" not found`);
    return p.id;
  };

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const userId: Record<string, string> = {};
  for (const [i, u] of users.entries()) {
    const created = await prisma.user.create({
      data: {
        email: `${u.key}${DEMO_DOMAIN}`,
        name: u.name,
        passwordHash,
        isPremium: u.isPremium ?? false,
        createdAt: daysAgo(45 - i * 3),
        skinProfile: {
          create: {
            skinType: u.skinType,
            concerns: u.concerns,
            sensitivities: u.sensitivities,
            goals: u.goals,
            monthlyBudget: u.monthlyBudget,
          },
        },
      },
    });
    userId[u.key] = created.id;
  }
  const uid = (key: string) => userId[key]!;
  // Reviews store "combo" (what the review form and Explore filter use);
  // profiles store onboarding's "combination".
  const skinOf = (key: string) =>
    users.find((u) => u.key === key)!.skinType.replace("combination", "combo");
  console.log(`Users: ${users.length} demo users (password ${DEMO_PASSWORD})`);

  await prisma.review.createMany({
    data: reviews.map(([author, product, rating, title, comment, ago]) => ({
      userId: uid(author),
      productId: productId(product),
      rating,
      title,
      comment,
      skinType: skinOf(author),
      concerns: users.find((u) => u.key === author)!.concerns,
      isVerifiedPurchase: rating >= 4,
      createdAt: daysAgo(ago, 19),
    })),
  });
  console.log(`Reviews: ${reviews.length}`);

  const postIds: string[] = [];
  for (const [author, category, title, content, tags, ago] of posts) {
    const post = await prisma.post.create({
      data: { userId: uid(author), category, title, content, tags, createdAt: daysAgo(ago, 11, 30) },
    });
    postIds.push(post.id);
  }
  await prisma.comment.createMany({
    data: comments.map(([post, author, content, ago]) => ({
      postId: postIds[post]!,
      userId: uid(author),
      content,
      createdAt: daysAgo(ago, 20),
    })),
  });
  await prisma.postLike.createMany({
    data: likes.flatMap(([post, likers]) =>
      likers.map((l) => ({ postId: postIds[post]!, userId: uid(l) })),
    ),
  });
  await prisma.bookmark.createMany({
    data: [1, 5].map((post) => ({ postId: postIds[post]!, userId: uid("demo") })),
  });
  console.log(`Community: ${posts.length} posts, ${comments.length} comments`);

  // Check-ins. The demo account has an 11-day run ending yesterday and none
  // today, so checking in live during a demo takes the streak to 12.
  const checkIns = [];
  for (let d = 11; d >= 1; d--) {
    checkIns.push({
      userId: uid("demo"),
      mood: [4, 3, 4, 5, 3, 4, 5, 4, 4, 5, 4][11 - d]!,
      note: moodNotes[d % moodNotes.length] ?? null,
      createdAt: daysAgo(d, 21, 15),
    });
  }
  for (const u of users.filter((x) => x.key !== "demo")) {
    for (let d = 0; d < 5; d++) {
      checkIns.push({
        userId: uid(u.key),
        mood: 3 + (d % 3),
        note: moodNotes[(d + u.key.length) % moodNotes.length] ?? null,
        createdAt: daysAgo(d * 2, 22),
      });
    }
  }
  await prisma.checkIn.createMany({ data: checkIns });
  console.log(`Check-ins: ${checkIns.length}`);

  // The demo account's shelf: one product expiring soon and one running low,
  // so the daily brief and My Products have something to point out.
  const shelf = [
    { name: "Gentle Skin Cleanser", openedAt: daysAgo(40), expiresAt: daysFromNow(140), quantityTotal: 250, quantityLeft: 120 },
    { name: "Niacinamide 5% Face Serum", openedAt: daysAgo(60), expiresAt: daysFromNow(5), quantityTotal: 30, quantityLeft: 4 },
    { name: "Ceramide & Hyaluronic Moisturiser", openedAt: daysAgo(20), expiresAt: daysFromNow(160), quantityTotal: 50, quantityLeft: 35 },
    { name: "Sun Expert Ultra Matte SPF 50", openedAt: daysAgo(15), expiresAt: daysFromNow(165), quantityTotal: 50, quantityLeft: 38 },
    { name: "Exfoliating Serum 10% AHA", openedAt: daysAgo(10), expiresAt: daysFromNow(170), quantityTotal: 30, quantityLeft: 26 },
  ];
  for (const s of shelf) {
    await prisma.userProduct.create({
      data: {
        userId: uid("demo"),
        productId: productId(s.name),
        openedAt: s.openedAt,
        expiresAt: s.expiresAt,
        quantityTotal: s.quantityTotal,
        quantityLeft: s.quantityLeft,
        quantityUnit: "ml",
      },
    });
  }
  await prisma.userProduct.create({
    data: {
      userId: uid("demo"),
      customName: "Rose Water Mist",
      customBrand: "Kama Ayurveda",
      openedAt: daysAgo(30),
      quantityTotal: 100,
      quantityLeft: 60,
      quantityUnit: "ml",
    },
  });

  const routines: { owner: string; name: string; timeOfDay: string; isShared: boolean; steps: string[] }[] = [
    { owner: "demo", name: "Morning glow", timeOfDay: "morning", isShared: true, steps: ["Gentle Skin Cleanser", "Niacinamide 5% Face Serum", "Ceramide & Hyaluronic Moisturiser", "Sun Expert Ultra Matte SPF 50"] },
    { owner: "demo", name: "Night reset", timeOfDay: "evening", isShared: false, steps: ["Gentle Skin Cleanser", "Exfoliating Serum 10% AHA", "Ceramide & Hyaluronic Moisturiser"] },
    { owner: "riya", name: "Oil control AM", timeOfDay: "morning", isShared: true, steps: ["Green Tea Pore Cleansing Face Wash", "Niacinamide 5% Face Serum", "Sun Expert Ultra Matte SPF 50"] },
    { owner: "meera", name: "Sensitive skin PM", timeOfDay: "evening", isShared: true, steps: ["Gentle Skin Cleanser", "Retinol 0.3% Face Serum", "Cicaplast Baume B5+"] },
  ];
  for (const r of routines) {
    await prisma.routine.create({
      data: {
        userId: uid(r.owner),
        name: r.name,
        timeOfDay: r.timeOfDay,
        isShared: r.isShared,
        steps: { create: r.steps.map((s, i) => ({ productId: productId(s), stepOrder: i + 1 })) },
      },
    });
  }
  console.log(`Shelf: ${shelf.length + 1} products, routines: ${routines.length}`);

  // Bounties the demo account has genuinely earned through the data above.
  for (const key of ["skin_assessment", "checkin_streak_3", "first_review", "first_routine", "community_post"]) {
    await awardBounty(uid("demo"), key);
  }
  for (const u of users.filter((x) => x.key !== "demo")) {
    await awardBounty(uid(u.key), "skin_assessment");
    await awardBounty(uid(u.key), "first_review");
  }
}

async function main() {
  const remove = process.argv.includes("--remove");
  const removed = await removeDemo();
  if (removed) console.log(`Removed ${removed} demo users and their data`);
  if (remove) return;
  await seed();
  console.log(`\nLog in with demo${DEMO_DOMAIN} / ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
