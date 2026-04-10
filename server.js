require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const MongoStore = require("connect-mongo");

const authRoutes = require("./routes/auth");

const app = express();

app.set("trust proxy", 1);

app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://flourai.io",
      "https://www.flourai.io",
    ],
    credentials: true,
  })
);

app.use(
  session({
    name: "flourai.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URL,
      collectionName: "sessions",
    }),
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Flourai API" });
});

app.use("/api/auth", authRoutes);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});