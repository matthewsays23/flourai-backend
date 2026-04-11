const axios = require("axios");

async function getUserGroups(userId) {
  const response = await axios.get(
    `https://groups.roblox.com/v2/users/${userId}/groups/roles`
  );

  return response.data?.data || [];
}

async function getUserGroupRole(userId, groupId) {
  const groups = await getUserGroups(userId);

  const match = groups.find(
    (entry) => Number(entry.group?.id) === Number(groupId)
  );

  if (!match) return null;

  return {
    groupId: match.group.id,
    groupName: match.group.name,
    roleId: match.role.id,
    roleName: match.role.name,
    rank: match.role.rank,
  };
}

async function getGroupRoles(groupId) {
  const response = await axios.get(
    `https://groups.roblox.com/v1/groups/${groupId}/roles`
  );

  return response.data?.roles || [];
}

async function getAllGroupMembers(groupId, limit = 100) {
  let cursor = "";
  let results = [];
  let pageCount = 0;

  while (pageCount < 10) {
    const url = new URL(`https://groups.roblox.com/v1/groups/${groupId}/users`);

    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sortOrder", "Asc");

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await axios.get(url.toString());
    const page = response.data;

    if (Array.isArray(page.data)) {
      results.push(...page.data);
    }

    if (!page.nextPageCursor) break;

    cursor = page.nextPageCursor;
    pageCount += 1;
  }

  return results;
}

async function getAvatarHeadshots(userIds = []) {
  if (!userIds.length) return {};

  const uniqueUserIds = [...new Set(userIds.map(String).filter(Boolean))];
  const chunkSize = 50;
  const map = {};

  for (let i = 0; i < uniqueUserIds.length; i += chunkSize) {
    const chunk = uniqueUserIds.slice(i, i + chunkSize);

    const response = await axios.get(
      "https://thumbnails.roblox.com/v1/users/avatar-headshot",
      {
        params: {
          userIds: chunk.join(","),
          size: "150x150",
          format: "Png",
          isCircular: false,
        },
      }
    );

    for (const item of response.data?.data || []) {
      map[String(item.targetId)] = item.imageUrl || "";
    }
  }

  return map;
}

module.exports = {
  getUserGroupRole,
  getGroupRoles,
  getAllGroupMembers,
  getAvatarHeadshots,
};