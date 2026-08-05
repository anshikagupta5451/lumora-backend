import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRouter from "./routes/auth";
import skinProfileRouter from "./routes/skinProfile";
import productsRouter from "./routes/products";
import reviewsRouter from "./routes/reviews";
import checkinsRouter from "./routes/checkins";
import ingredientsRouter from "./routes/ingredients";
import { startStreakReminderJob } from './jobs/streakReminder'
import recommendationsRouter from "./routes/recommendations";
import routinesRouter from "./routes/routines";
import routineStepsRouter from "./routes/routineSteps";
import usersRouter from './routes/users'
import userProductsRouter from './routes/userProducts'

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Lumora backend is running" });
});

app.use("/auth", authRouter);
app.use('/skin-profile', skinProfileRouter)
app.use('/users', usersRouter)
app.use('/products', productsRouter)
app.use('/reviews', reviewsRouter)
app.use('/checkins', checkinsRouter)
app.use('/ingredients', ingredientsRouter)
app.use('/recommendations', recommendationsRouter)
app.use('/routines', routinesRouter)
app.use('/routine-steps', routineStepsRouter)
app.use('/user-products', userProductsRouter)

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
startStreakReminderJob()
