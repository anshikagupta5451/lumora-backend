import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRouter from "./routes/auth";
import skinProfileRouter from "./routes/skinProfile";
import productsRouter from "./routes/products";
import reviewsRouter from "./routes/reviews";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Lumora backend is running" });
});

app.use("/auth", authRouter);
app.use('/skin-profile', skinProfileRouter)
app.use('/products', productsRouter)
app.use('/reviews', reviewsRouter)

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
