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

function safeString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeUserId(value) {
  return String(value || "").trim();
}

function createDefaultWeeklyActivity() {
  return [
    { label: "Mon", minutes: 0 },
    { label: "Tue", minutes: 0 },
    { label: "Wed", minutes: 0 },
    { label: "Thu", minutes: 0 },
    { label: "Fri", minutes: 0 },
    { label: "Sat", minutes: 0 },
    { label: "Sun", minutes: 0 },
  ];
}

function normalizeWeeklyActivity(weeklyActivity) {
  const defaults = createDefaultWeeklyActivity();

  if (!Array.isArray(weeklyActivity)) return defaults;

  return defaults.map((day) => {
    const match = weeklyActivity.find(
      (entry) => String(entry?.label || "").toLowerCase() === day.label.toLowerCase()
    );

    return {
      label: day.label,
      minutes: Number(match?.minutes || 0),
    };
  });
}

function totalWeeklyMinutes(weeklyActivity = []) {
  return weeklyActivity.reduce((sum, day) => sum + Number(day.minutes || 0), 0);
}

function makeId(prefix = "item") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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
        canManageMembers: false,
        canManageActivity: false,
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

  // Reuse refreshRoleBinds for now so owners/admins can manage member profiles.
  const canManageMembers = canRefreshMembers;
  const canManageActivity = canRefreshMembers;

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
      canManageMembers,
      canManageActivity,
    },
  };
}

async function requireWorkspaceMemberAccess(req, res) {
  const access = await buildWorkspaceAccess(req.session.user);

  if (!access.viewer.inGroup) {
    res.status(403).json({
      ok: false,
      error: "You are not in the Flourai group",
    });
    return null;
  }

  return access;
}

async function getMemberDoc(db, userId) {
  return db.collection("workspaceMembers").findOne({
    groupId: WORKSPACE_CONFIG.groupId,
    userId: normalizeUserId(userId),
  });
}

async function getOrCreateMemberProfile(db, memberDoc) {
  const collection = db.collection("workspaceMemberProfiles");

  const existing = await collection.findOne({
    groupId: WORKSPACE_CONFIG.groupId,
    userId: memberDoc.userId,
  });

  if (existing) {
    return {
      ...existing,
      warnings: Array.isArray(existing.warnings) ? existing.warnings : [],
      suspensions: Array.isArray(existing.suspensions) ? existing.suspensions : [],
      notes: Array.isArray(existing.notes) ? existing.notes : [],
      weeklyActivity: normalizeWeeklyActivity(existing.weeklyActivity),
    };
  }

  const created = {
    groupId: WORKSPACE_CONFIG.groupId,
    userId: memberDoc.userId,
    weeklyActivity: createDefaultWeeklyActivity(),
    warnings: [],
    suspensions: [],
    notes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await collection.insertOne(created);
  return created;
}

async function buildMemberProfilePayload(db, req, memberDoc) {
  const profile = await getOrCreateMemberProfile(db, memberDoc);

  return {
    userId: String(memberDoc.userId),
    username: memberDoc.username,
    displayName: memberDoc.displayName,
    avatar: memberDoc.avatar || "",
    roleName: memberDoc.roleName,
    roleLabel: memberDoc.roleLabel || memberDoc.roleName,
    rank: Number(memberDoc.rank || 0),
    isConnectedUser:
      String(memberDoc.userId) === String(req.session.user.robloxId),
    weeklyActivity: normalizeWeeklyActivity(profile.weeklyActivity),
    weeklyTotalMinutes: totalWeeklyMinutes(profile.weeklyActivity),
    warnings: Array.isArray(profile.warnings) ? profile.warnings : [],
    suspensions: Array.isArray(profile.suspensions) ? profile.suspensions : [],
    notes: Array.isArray(profile.notes) ? profile.notes : [],
    updatedAt: profile.updatedAt || null,
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
    console.error("Workspace access error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load workspace access",
    });
  }
});

router.get("/members", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    const db = await getDb();

    const members = await db
      .collection("workspaceMembers")
      .find({
        groupId: WORKSPACE_CONFIG.groupId,
        inDirectory: true,
      })
      .sort({ rank: -1, displayName: 1 })
      .toArray();

    const profiles = await db
      .collection("workspaceMemberProfiles")
      .find({
        groupId: WORKSPACE_CONFIG.groupId,
        userId: { $in: members.map((member) => String(member.userId)) },
      })
      .toArray();

    const profileMap = new Map(
      profiles.map((profile) => [String(profile.userId), profile])
    );

    const normalized = members.map((member) => {
      const profile = profileMap.get(String(member.userId));

      const weeklyActivity = normalizeWeeklyActivity(profile?.weeklyActivity);
      const warnings = Array.isArray(profile?.warnings) ? profile.warnings : [];
      const suspensions = Array.isArray(profile?.suspensions)
        ? profile.suspensions
        : [];
      const notes = Array.isArray(profile?.notes) ? profile.notes : [];

      return {
        userId: String(member.userId),
        username: member.username,
        displayName: member.displayName,
        avatar: member.avatar || "",
        roleName: member.roleName,
        roleLabel: member.roleLabel || member.roleName,
        rank: member.rank,
        isConnectedUser:
          String(member.userId) === String(req.session.user.robloxId),
        weeklyActivity,
        weeklyTotalMinutes: totalWeeklyMinutes(weeklyActivity),
        warningCount: warnings.length,
        suspensionCount: suspensions.length,
        noteCount: notes.length,
      };
    });

    return res.json({
      ok: true,
      members: normalized,
    });
  } catch (error) {
    console.error("Workspace members error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load members",
    });
  }
});

router.get("/members/:userId/profile", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    const userId = normalizeUserId(req.params.userId);
    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "Missing member userId",
      });
    }

    const db = await getDb();
    const memberDoc = await getMemberDoc(db, userId);

    if (!memberDoc) {
      return res.status(404).json({
        ok: false,
        error: "Member not found",
      });
    }

    const profile = await buildMemberProfilePayload(db, req, memberDoc);

    return res.json({
      ok: true,
      member: profile,
      permissions: access.permissions,
    });
  } catch (error) {
    console.error("Workspace member profile error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load member profile",
    });
  }
});

router.post("/members/:userId/warnings", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canManageMembers) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to manage member warnings",
      });
    }

    const userId = normalizeUserId(req.params.userId);
    const reason = safeString(req.body?.reason);

    if (!userId || !reason) {
      return res.status(400).json({
        ok: false,
        error: "A warning reason is required",
      });
    }

    const db = await getDb();
    const memberDoc = await getMemberDoc(db, userId);

    if (!memberDoc) {
      return res.status(404).json({
        ok: false,
        error: "Member not found",
      });
    }

    const warning = {
      id: makeId("warning"),
      reason,
      createdAt: new Date(),
      createdBy: {
        robloxId: String(req.session.user.robloxId),
        username: req.session.user.username,
        displayName: req.session.user.displayName,
      },
    };

    await db.collection("workspaceMemberProfiles").updateOne(
      {
        groupId: WORKSPACE_CONFIG.groupId,
        userId,
      },
      {
        $setOnInsert: {
          groupId: WORKSPACE_CONFIG.groupId,
          userId,
          weeklyActivity: createDefaultWeeklyActivity(),
          warnings: [],
          suspensions: [],
          notes: [],
          createdAt: new Date(),
        },
        $push: {
          warnings: {
            $each: [warning],
            $position: 0,
          },
        },
        $set: {
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    const profile = await buildMemberProfilePayload(db, req, memberDoc);

    return res.json({
      ok: true,
      message: "Warning added",
      member: profile,
    });
  } catch (error) {
    console.error("Workspace warning create error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to add warning",
    });
  }
});

router.post("/members/:userId/suspensions", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canManageMembers) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to manage suspensions",
      });
    }

    const userId = normalizeUserId(req.params.userId);
    const details = safeString(req.body?.details);

    if (!userId || !details) {
      return res.status(400).json({
        ok: false,
        error: "Suspension details are required",
      });
    }

    const db = await getDb();
    const memberDoc = await getMemberDoc(db, userId);

    if (!memberDoc) {
      return res.status(404).json({
        ok: false,
        error: "Member not found",
      });
    }

    const suspension = {
      id: makeId("suspension"),
      details,
      createdAt: new Date(),
      createdBy: {
        robloxId: String(req.session.user.robloxId),
        username: req.session.user.username,
        displayName: req.session.user.displayName,
      },
    };

    await db.collection("workspaceMemberProfiles").updateOne(
      {
        groupId: WORKSPACE_CONFIG.groupId,
        userId,
      },
      {
        $setOnInsert: {
          groupId: WORKSPACE_CONFIG.groupId,
          userId,
          weeklyActivity: createDefaultWeeklyActivity(),
          warnings: [],
          suspensions: [],
          notes: [],
          createdAt: new Date(),
        },
        $push: {
          suspensions: {
            $each: [suspension],
            $position: 0,
          },
        },
        $set: {
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    const profile = await buildMemberProfilePayload(db, req, memberDoc);

    return res.json({
      ok: true,
      message: "Suspension added",
      member: profile,
    });
  } catch (error) {
    console.error("Workspace suspension create error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to add suspension",
    });
  }
});

router.post("/members/:userId/notes", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canManageMembers) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to manage notes",
      });
    }

    const userId = normalizeUserId(req.params.userId);
    const body = safeString(req.body?.body);

    if (!userId || !body) {
      return res.status(400).json({
        ok: false,
        error: "A note body is required",
      });
    }

    const db = await getDb();
    const memberDoc = await getMemberDoc(db, userId);

    if (!memberDoc) {
      return res.status(404).json({
        ok: false,
        error: "Member not found",
      });
    }

    const note = {
      id: makeId("note"),
      body,
      createdAt: new Date(),
      createdBy: {
        robloxId: String(req.session.user.robloxId),
        username: req.session.user.username,
        displayName: req.session.user.displayName,
      },
    };

    await db.collection("workspaceMemberProfiles").updateOne(
      {
        groupId: WORKSPACE_CONFIG.groupId,
        userId,
      },
      {
        $setOnInsert: {
          groupId: WORKSPACE_CONFIG.groupId,
          userId,
          weeklyActivity: createDefaultWeeklyActivity(),
          warnings: [],
          suspensions: [],
          notes: [],
          createdAt: new Date(),
        },
        $push: {
          notes: {
            $each: [note],
            $position: 0,
          },
        },
        $set: {
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    const profile = await buildMemberProfilePayload(db, req, memberDoc);

    return res.json({
      ok: true,
      message: "Note added",
      member: profile,
    });
  } catch (error) {
    console.error("Workspace note create error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to add note",
    });
  }
});

router.put("/members/:userId/activity", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canManageActivity) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to manage member activity",
      });
    }

    const userId = normalizeUserId(req.params.userId);
    const weeklyActivity = normalizeWeeklyActivity(req.body?.weeklyActivity);

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "Missing member userId",
      });
    }

    const db = await getDb();
    const memberDoc = await getMemberDoc(db, userId);

    if (!memberDoc) {
      return res.status(404).json({
        ok: false,
        error: "Member not found",
      });
    }

    await db.collection("workspaceMemberProfiles").updateOne(
      {
        groupId: WORKSPACE_CONFIG.groupId,
        userId,
      },
      {
        $setOnInsert: {
          groupId: WORKSPACE_CONFIG.groupId,
          userId,
          warnings: [],
          suspensions: [],
          notes: [],
          createdAt: new Date(),
        },
        $set: {
          weeklyActivity,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    const profile = await buildMemberProfilePayload(db, req, memberDoc);

    return res.json({
      ok: true,
      message: "Weekly activity updated",
      member: profile,
    });
  } catch (error) {
    console.error("Workspace activity update error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to update member activity",
    });
  }
});

router.get("/activity/overview", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    const db = await getDb();

    const members = await db
      .collection("workspaceMembers")
      .find({
        groupId: WORKSPACE_CONFIG.groupId,
        inDirectory: true,
      })
      .sort({ rank: -1, displayName: 1 })
      .toArray();

    const profiles = await db
      .collection("workspaceMemberProfiles")
      .find({
        groupId: WORKSPACE_CONFIG.groupId,
        userId: { $in: members.map((member) => String(member.userId)) },
      })
      .toArray();

    const profileMap = new Map(
      profiles.map((profile) => [String(profile.userId), profile])
    );

    const dailyLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const targetMinutes = Number(WORKSPACE_CONFIG.weeklyActivityTarget || 30);

    const normalizedMembers = members.map((member) => {
      const profile = profileMap.get(String(member.userId));
      const weeklyActivity = normalizeWeeklyActivity(profile?.weeklyActivity);

      return {
        userId: String(member.userId),
        username: member.username,
        displayName: member.displayName,
        avatar: member.avatar || "",
        roleName: member.roleName,
        roleLabel: member.roleLabel || member.roleName,
        rank: Number(member.rank || 0),
        weeklyActivity,
        weeklyTotalMinutes: totalWeeklyMinutes(weeklyActivity),
      };
    });

    const totalMembers = normalizedMembers.length;
    const totalMinutes = normalizedMembers.reduce(
      (sum, member) => sum + member.weeklyTotalMinutes,
      0
    );
    const activeMembers = normalizedMembers.filter(
      (member) => member.weeklyTotalMinutes > 0
    ).length;
    const averageMinutes = totalMembers
      ? Math.round(totalMinutes / totalMembers)
      : 0;
    const onTrackMembers = normalizedMembers.filter(
      (member) => member.weeklyTotalMinutes >= targetMinutes
    ).length;
    const quotaRate = totalMembers
      ? Math.round((onTrackMembers / totalMembers) * 100)
      : 0;

    const weekSeries = dailyLabels.map((label) => ({
      label,
      minutes: normalizedMembers.reduce((sum, member) => {
        const match = member.weeklyActivity.find((entry) => entry.label === label);
        return sum + Number(match?.minutes || 0);
      }, 0),
    }));

    const topMembers = [...normalizedMembers]
      .sort((a, b) => b.weeklyTotalMinutes - a.weeklyTotalMinutes)
      .slice(0, 5);

    return res.json({
      ok: true,
      summary: {
        totalMembers,
        totalMinutes,
        activeMembers,
        averageMinutes,
        onTrackMembers,
        quotaRate,
        targetMinutes,
      },
      weekly: weekSeries,
      topMembers,
    });
  } catch (error) {
    console.error("Workspace activity overview error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load activity overview",
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

    const userIds = allMembers
      .map((member) => String(member.user?.userId))
      .filter(Boolean);

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

      const profileOps = docs.map((doc) => ({
        updateOne: {
          filter: {
            groupId: doc.groupId,
            userId: doc.userId,
          },
          update: {
            $setOnInsert: {
              groupId: doc.groupId,
              userId: doc.userId,
              weeklyActivity: createDefaultWeeklyActivity(),
              warnings: [],
              suspensions: [],
              notes: [],
              createdAt: new Date(),
            },
            $set: {
              updatedAt: new Date(),
            },
          },
          upsert: true,
        },
      }));

      await db.collection("workspaceMemberProfiles").bulkWrite(profileOps);
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
          weeklyActivityTarget: Number(
            WORKSPACE_CONFIG.weeklyActivityTarget || 30
          ),
        },
      },
      { upsert: true }
    );

    return res.json({
      ok: true,
      synced: docs.length,
      inDirectory: docs.filter((doc) => doc.inDirectory).length,
    });
  } catch (error) {
    console.error("Workspace refresh error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to refresh members",
    });
  }
});

module.exports = router;