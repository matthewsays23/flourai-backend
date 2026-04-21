const express = require("express");

const requireAuth = require("../middleware/requireAuth");
const { getDb } = require("../lib/mongo");
const { getUserGroupRole } = require("../utils/robloxGroup");
const { WORKSPACE_CONFIG } = require("../utils/workspaceConfig");
const {
  applyDiscordVerification,
  exchangeDiscordCode,
  getDiscordUser,
  getDesiredRoleIds,
  isAutoRoleBindEnabled,
  parseRoleBinds,
} = require("../utils/discordVerification");
const { createState } = require("../utils/pkce");

const router = express.Router();

function getFrontendUrl() {
  return process.env.FRONTEND_URL || "https://flourai.io";
}

function getDiscordRedirectUri() {
  return process.env.DISCORD_REDIRECT_URI;
}

function getDiscordScopes() {
  return process.env.DISCORD_OAUTH_SCOPES || "identify guilds.join";
}

function getMissingDiscordConfig() {
  return [
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_REDIRECT_URI",
    "DISCORD_BOT_TOKEN",
    "DISCORD_GUILD_ID",
  ].filter((key) => !process.env[key]);
}

function buildVerifyRedirect(params = {}) {
  const url = new URL("/verify", getFrontendUrl());

  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}

router.get("/status", async (req, res) => {
  try {
    const robloxUser = req.session?.user || null;

    if (!robloxUser) {
      return res.json({
        ok: true,
        roblox: null,
        discord: null,
        bind: null,
        roleBinds: parseRoleBinds(),
      });
    }

    const db = await getDb();
    const bind = await db.collection("discord_verifications").findOne({
      robloxId: String(robloxUser.robloxId),
    });
    const robloxRole = await getUserGroupRole(
      robloxUser.robloxId,
      WORKSPACE_CONFIG.groupId
    ).catch(() => null);

    return res.json({
      ok: true,
      roblox: robloxUser,
      discord: bind
        ? {
            id: bind.discordId,
            username: bind.discordUsername,
            nickname: bind.nickname,
          }
        : null,
      bind,
      robloxRole,
      desiredRoleIds: await getDesiredRoleIds(robloxRole),
      autoRoleBinds: isAutoRoleBindEnabled(),
      roleBinds: parseRoleBinds(),
    });
  } catch (error) {
    console.error("Verification status error:", error.response?.data || error.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to load verification status.",
    });
  }
});

router.get("/discord/start", requireAuth, (req, res) => {
  const redirectUri = getDiscordRedirectUri();
  const missing = getMissingDiscordConfig();

  if (missing.length) {
    return res.status(500).send(`Discord OAuth is missing: ${missing.join(", ")}`);
  }

  const state = createState();
  req.session.discord_oauth_state = state;

  req.session.save((err) => {
    if (err) {
      console.error("Discord state save error:", err);
      return res.status(500).send("Failed to start Discord verification.");
    }

    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: getDiscordScopes(),
      state,
      prompt: "consent",
    });

    return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });
});

router.get("/discord/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!req.session?.user) {
      return res.redirect(buildVerifyRedirect({ result: "error", message: "roblox_session_expired" }));
    }

    if (!code || !state) {
      return res.redirect(buildVerifyRedirect({ result: "error", message: "missing_oauth" }));
    }

    if (!req.session.discord_oauth_state || state !== req.session.discord_oauth_state) {
      return res.redirect(buildVerifyRedirect({ result: "error", message: "bad_state" }));
    }

    const tokens = await exchangeDiscordCode(String(code));
    const discordUser = await getDiscordUser(tokens.access_token);
    const robloxUser = req.session.user;
    const robloxRole = await getUserGroupRole(
      robloxUser.robloxId,
      WORKSPACE_CONFIG.groupId
    ).catch(() => null);

    const applied = await applyDiscordVerification({
      discordUser,
      discordAccessToken: tokens.access_token,
      robloxUser,
      robloxRole,
    });

    const db = await getDb();
    const now = new Date();

    await db.collection("discord_verifications").updateOne(
      { discordId: String(discordUser.id) },
      {
        $set: {
          discordId: String(discordUser.id),
          discordUsername: applied.discordUsername,
          robloxId: String(robloxUser.robloxId),
          robloxUsername: robloxUser.username,
          robloxDisplayName: robloxUser.displayName,
          robloxRole,
          nickname: applied.nickname,
          assignedRoleIds: applied.desiredRoleIds,
          joinedGuild: applied.joined,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true }
    );

    delete req.session.discord_oauth_state;

    req.session.save((err) => {
      if (err) {
        console.error("Discord callback session save error:", err);
      }

      return res.redirect(buildVerifyRedirect({ result: "success" }));
    });
  } catch (error) {
    console.error("Discord verification error:", error.response?.data || error.message);
    return res.redirect(
      buildVerifyRedirect({
        result: "error",
        message: "apply_failed",
      })
    );
  }
});

module.exports = router;
