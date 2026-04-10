require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const session = require("express-session");

const authRoutes = require("./routes/auth");

const app = express();

app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // IMPORTANT for localhost
      sameSite: "lax",
    },
  })
);

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Flourai API" });
});

app.use("/auth", authRoutes);

app.get("/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: "Not logged in" });
  }

  return res.json({
    ok: true,
    user: req.session.user,
  });
});

app.get("/api/roblox-avatar/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const response = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    );

    const data = await response.json();
    const imageUrl = data?.data?.[0]?.imageUrl || null;

    res.json({ imageUrl });
  } catch (error) {
    console.error("Avatar fetch error:", error);
    res.status(500).json({ message: "Failed to fetch avatar" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Flourai backend running on port ${PORT}`);
});