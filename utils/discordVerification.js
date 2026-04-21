const axios = require("axios");
const { getGroupRoles } = require("./robloxGroup");

const DISCORD_API = "https://discord.com/api/v10";
const roleCache = {
  expiresAt: 0,
  roles: [],
};

function getBotToken() {
  return process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || "";
}

function getGuildId() {
  return process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || "";
}

function getDiscordHeaders() {
  const token = getBotToken();

  if (!token) {
    throw new Error("Discord bot token is not configured.");
  }

  return {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };
}

function parseRoleBinds() {
  const raw = process.env.DISCORD_ROLE_BINDS || "[]";

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((bind) => bind?.roleId) : [];
  } catch (error) {
    console.error("Invalid DISCORD_ROLE_BINDS JSON:", error.message);
    return [];
  }
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function isAutoRoleBindEnabled() {
  return process.env.DISCORD_AUTO_ROLE_BINDS !== "false";
}

function isAutoRoleCreateEnabled() {
  return process.env.DISCORD_AUTO_CREATE_BIND_ROLES === "true";
}

function roleBindMatches(bind, robloxRole) {
  if (!robloxRole) return false;

  if (bind.robloxRoleName && normalize(bind.robloxRoleName) !== normalize(robloxRole.roleName)) {
    return false;
  }

  if (Number.isFinite(Number(bind.minRank)) && Number(robloxRole.rank || 0) < Number(bind.minRank)) {
    return false;
  }

  if (Number.isFinite(Number(bind.maxRank)) && Number(robloxRole.rank || 0) > Number(bind.maxRank)) {
    return false;
  }

  return true;
}

async function fetchGuildRoles() {
  const now = Date.now();

  if (roleCache.expiresAt > now) {
    return roleCache.roles;
  }

  const guildId = getGuildId();
  const response = await axios.get(`${DISCORD_API}/guilds/${guildId}/roles`, {
    headers: getDiscordHeaders(),
  });

  roleCache.roles = response.data || [];
  roleCache.expiresAt = now + 1000 * 60 * 5;

  return roleCache.roles;
}

async function createGuildRole(name) {
  const guildId = getGuildId();
  const response = await axios.post(
    `${DISCORD_API}/guilds/${guildId}/roles`,
    {
      name,
      mentionable: false,
      hoist: false,
    },
    { headers: getDiscordHeaders() }
  );

  roleCache.expiresAt = 0;
  return response.data;
}

async function findOrCreateDiscordRoleByName(name) {
  if (!name) return null;

  const roles = await fetchGuildRoles();
  const existing = roles.find((role) => normalize(role.name) === normalize(name));

  if (existing) return existing;
  if (!isAutoRoleCreateEnabled()) return null;

  return createGuildRole(name);
}

async function getAutoRoleBindIds(robloxRole) {
  if (!isAutoRoleBindEnabled() || !robloxRole?.roleName) return [];

  const role = await findOrCreateDiscordRoleByName(robloxRole.roleName);
  return role?.id ? [role.id] : [];
}

async function getDesiredRoleIds(robloxRole) {
  const roleIds = new Set();

  if (process.env.DISCORD_VERIFIED_ROLE_ID) {
    roleIds.add(process.env.DISCORD_VERIFIED_ROLE_ID);
  }

  for (const roleId of await getAutoRoleBindIds(robloxRole)) {
    roleIds.add(roleId);
  }

  for (const bind of parseRoleBinds()) {
    if (roleBindMatches(bind, robloxRole)) {
      roleIds.add(bind.roleId);
    }
  }

  return [...roleIds];
}

async function getConfiguredBindRoleIds() {
  const roleIds = new Set(parseRoleBinds().map((bind) => bind.roleId));

  if (isAutoRoleBindEnabled()) {
    const groupId = process.env.FLOURAI_GROUP_ID || process.env.ROBLOX_GROUP_ID;
    const discordRoles = await fetchGuildRoles();
    const discordRoleByName = new Map(
      discordRoles.map((role) => [normalize(role.name), role.id])
    );

    if (groupId) {
      const robloxRoles = await getGroupRoles(groupId).catch(() => []);

      for (const robloxRole of robloxRoles) {
        const discordRoleId = discordRoleByName.get(normalize(robloxRole.name));
        if (discordRoleId) roleIds.add(discordRoleId);
      }
    }
  }

  return [...roleIds];
}

function formatNickname(robloxUser, robloxRole) {
  const template = process.env.DISCORD_VERIFY_NICKNAME_FORMAT || "{robloxUsername}";
  const username = robloxUser?.username || robloxUser?.displayName || "Roblox User";
  const displayName = robloxUser?.displayName || username;

  return template
    .replaceAll("{robloxUsername}", username)
    .replaceAll("{robloxDisplayName}", displayName)
    .replaceAll("{robloxRole}", robloxRole?.roleName || "Not In Group")
    .slice(0, 32);
}

async function exchangeDiscordCode(code) {
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;

  if (!redirectUri || !clientId || !clientSecret) {
    throw new Error("Discord OAuth environment variables are not configured.");
  }

  const response = await axios.post(
    `${DISCORD_API}/oauth2/token`,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return response.data;
}

async function getDiscordUser(accessToken) {
  const response = await axios.get(`${DISCORD_API}/users/@me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return response.data;
}

async function fetchGuildMember(discordUserId) {
  const guildId = getGuildId();

  if (!guildId) {
    throw new Error("Discord guild id is not configured.");
  }

  try {
    const response = await axios.get(
      `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}`,
      { headers: getDiscordHeaders() }
    );
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

async function addGuildMember(discordUserId, accessToken, roleIds, nickname) {
  const guildId = getGuildId();

  const response = await axios.put(
    `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}`,
    {
      access_token: accessToken,
      nick: nickname,
      roles: roleIds,
    },
    { headers: getDiscordHeaders() }
  );

  return response.data || null;
}

async function setNickname(discordUserId, nickname) {
  if (!nickname) return;

  const guildId = getGuildId();

  await axios.patch(
    `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}`,
    { nick: nickname },
    { headers: getDiscordHeaders() }
  );
}

async function addRole(discordUserId, roleId) {
  const guildId = getGuildId();

  await axios.put(
    `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`,
    null,
    { headers: getDiscordHeaders() }
  );
}

async function removeRole(discordUserId, roleId) {
  const guildId = getGuildId();

  await axios.delete(
    `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`,
    { headers: getDiscordHeaders() }
  );
}

async function applyDiscordVerification({
  discordUser,
  discordAccessToken,
  robloxUser,
  robloxRole,
}) {
  const desiredRoleIds = await getDesiredRoleIds(robloxRole);
  const nickname = formatNickname(robloxUser, robloxRole);
  let member = await fetchGuildMember(discordUser.id);
  let joined = false;

  if (!member) {
    member = await addGuildMember(
      discordUser.id,
      discordAccessToken,
      desiredRoleIds,
      nickname
    );
    joined = true;
  }

  if (!joined) {
    await setNickname(discordUser.id, nickname);

    for (const roleId of desiredRoleIds) {
      if (!member?.roles?.includes(roleId)) {
        await addRole(discordUser.id, roleId);
      }
    }

    if (process.env.DISCORD_REMOVE_UNMATCHED_BIND_ROLES === "true") {
      const desired = new Set(desiredRoleIds);

      for (const roleId of await getConfiguredBindRoleIds()) {
        if (member?.roles?.includes(roleId) && !desired.has(roleId)) {
          await removeRole(discordUser.id, roleId);
        }
      }
    }
  }

  return {
    discordId: discordUser.id,
    discordUsername: discordUser.global_name || discordUser.username,
    desiredRoleIds,
    nickname,
    joined,
  };
}

module.exports = {
  applyDiscordVerification,
  exchangeDiscordCode,
  getDiscordUser,
  getDesiredRoleIds,
  isAutoRoleBindEnabled,
  parseRoleBinds,
};
