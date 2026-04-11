const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const { getDb } = require("../lib/mongo");
const { WORKSPACE_CONFIG } = require("../utils/workspaceConfig");
const {
  getUserGroupRole,
  getAllGroupMembers,
  getAvatarHeadshots,
} = require("../utils/robloxGroup");

const router = express.Router();

function hasBoundRole(roleName, allowedRoles = []) {
  return allowedRoles.some(
    (allowed) => allowed.toLowerCase() === String(roleName || "").toLowerCase()
  );
}

async function buildWorkspaceAccess(user) {
  const viewerRole = await getUserGroupRole(
    user.robloxId,
    WORKSPACE_CONFIG.groupId
  );

  if (!viewerRole) {
    return {
      workspace: {
        groupId: WORKSPACE_CONFIG.groupId,
        name: WORKSPACE_CONFIG.name,
        lastMemberSync: null,
      },
      viewer: {
        inGroup: false,
        roleName: null,
        roleLabel: "Not In Group",
        rank: null,
      },
      permissions: {
        canViewMembers: false,
        canRefreshMembers: false,
      },
    };
  }

  const db = await getDb();
  const settings = await db.collection("workspaceSettings").findOne({
    groupId: WORKSPACE_CONFIG.groupId,
  });

  const canViewMembers = true;

  const canRefreshMembers = hasBoundRole(
    viewerRole.roleName,
    WORKSPACE_CONFIG.refreshRoleBinds || []
  );

  return {
    workspace: {
      groupId: WORKSPACE_CONFIG.groupId,
      name: WORKSPACE_CONFIG.name,
      lastMemberSync: settings?.lastMemberSync || null,
    },
    viewer: {
      inGroup: true,
      roleName: viewerRole.roleName,
      roleLabel: viewerRole.roleName,
      rank: viewerRole.rank,
    },
    permissions: {
      canViewMembers,
      canRefreshMembers,
    },
  };
}

router.get("/access", requireAuth, async (req, res) => {
  try {
    const access = await buildWorkspaceAccess(req.session.user);

    return res.json({
      ok: true,
      ...access,
    });
  } catch (error) {
    console.error("Workspace access error:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to load workspace access",
    });
  }
});

router.get("/members", requireAuth, async (req, res) => {
  try {
    const access = await buildWorkspaceAccess(req.session.user);

    if (!access.viewer.inGroup) {
      return res.status(403).json({
        ok: false,
        error: "You are not in the Flourai group",
      });
    }

    const db = await getDb();

    const members = await db
      .collection("workspaceMembers")
      .find({
        groupId: WORKSPACE_CONFIG.groupId,
        inDirectory: true,
      })
      .sort({ rank: -1, displayName: 1 })
      .toArray();

    const normalized = members.map((member) => ({
      userId: String(member.userId),
      username: member.username,
      displayName: member.displayName,
      avatar: member.avatar || "",
      roleName: member.roleName,
      roleLabel: member.roleLabel || member.roleName,
      rank: member.rank,
      isConnectedUser:
        String(member.userId) === String(req.session.user.robloxId),
    }));

    return res.json({
      ok: true,
      members: normalized,
    });
  } catch (error) {
    console.error("Workspace members error:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to load members",
    });
  }
});

router.post("/members/refresh", requireAuth, async (req, res) => {
  try {
    const access = await buildWorkspaceAccess(req.session.user);

    if (!access.permissions.canRefreshMembers) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to refresh members",
      });
    }

    const db = await getDb();

    const allMembers = await getAllGroupMembers(WORKSPACE_CONFIG.groupId, 100);

    const userIds = allMembers.map((member) => String(member.user.userId));
    const avatarMap = await getAvatarHeadshots(userIds);

    const docs = allMembers.map((member) => {
      const roleName = member.role?.name || "Member";
      const rank = Number(member.role?.rank || 0);

      const inDirectory =
        rank >= Number(WORKSPACE_CONFIG.directoryRankMin || 23) &&
        rank <= Number(WORKSPACE_CONFIG.directoryRankMax || 44);

      return {
        groupId: WORKSPACE_CONFIG.groupId,
        userId: String(member.user.userId),
        username: member.user.username,
        displayName: member.user.displayName || member.user.username,
        avatar: avatarMap[String(member.user.userId)] || "",
        roleId: member.role?.id || null,
        roleName,
        roleLabel: roleName,
        rank,
        inDirectory,
        lastSyncedAt: new Date(),
      };
    });

    const collection = db.collection("workspaceMembers");

    if (docs.length) {
      const operations = docs.map((doc) => ({
        updateOne: {
          filter: {
            groupId: doc.groupId,
            userId: doc.userId,
          },
          update: {
            $set: doc,
          },
          upsert: true,
        },
      }));

      await collection.bulkWrite(operations);
    }

    await db.collection("workspaceSettings").updateOne(
      { groupId: WORKSPACE_CONFIG.groupId },
      {
        $set: {
          groupId: WORKSPACE_CONFIG.groupId,
          workspaceName: WORKSPACE_CONFIG.name,
          lastMemberSync: new Date(),
          directoryRankMin: Number(WORKSPACE_CONFIG.directoryRankMin || 23),
          directoryRankMax: Number(WORKSPACE_CONFIG.directoryRankMax || 44),
          refreshRoleBinds: WORKSPACE_CONFIG.refreshRoleBinds || [],
        },
      },
      { upsert: true }
    );

    return res.json({
      ok: true,
      synced: docs.length,
    });
  } catch (error) {
    console.error("Workspace refresh error:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to refresh members",
    });
  }
});

module.exports = router;