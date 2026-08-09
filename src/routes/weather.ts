import express from "express";
import { requireAuth } from "../middleware/requireAuth";

const router = express.Router();

router.get("/current", requireAuth, async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "lat and lon query params required" });
  }

  try {
    const response = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`,
    );
    const data = await response.json();

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: data.message || "Weather fetch failed" });
    }

    res.json({
      temp: Math.round(data.main.temp),
      condition: data.weather[0]?.main || "Unknown",
      description: data.weather[0]?.description || "",
      humidity: data.main.humidity,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch weather data" });
  }
});

export default router;
