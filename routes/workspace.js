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
      (entry) =>
        String(entry?.label || "").toLowerCase() === day.label.toLowerCase()
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

function normalizeRoleName(member) {
  if (typeof member?.roleName === "string" && member.roleName.trim()) {
    return member.roleName.trim();
  }

  if (typeof member?.role === "string" && member.role.trim()) {
    return member.role.trim();
  }

  if (member?.role && typeof member.role === "object") {
    if (typeof member.role.name === "string" && member.role.name.trim()) {
      return member.role.name.trim();
    }
  }

  return "Member";
}

function normalizeRank(member) {
  if (Number.isFinite(Number(member?.rank))) {
    return Number(member.rank);
  }

  if (member?.role && typeof member.role === "object") {
    if (Number.isFinite(Number(member.role.rank))) {
      return Number(member.role.rank);
    }
  }

  return 0;
}

function getDefaultDepartments() {
  return {
    staffing: {
      key: "staffing",
      label: "Staffing Department",
      permissions: {
        canWarn: true,
        canSuspend: true,
        canAddNotes: true,
        canViewActivity: true,
        canManageWebsite: false,
      },
      members: [],
    },
    communications: {
      key: "communications",
      label: "Communications",
      permissions: {
        canWarn: false,
        canSuspend: false,
        canAddNotes: false,
        canViewActivity: true,
        canManageWebsite: false,
      },
      members: [],
    },
  };
}

function normalizeDepartmentCollection(input) {
  const defaults = getDefaultDepartments();
  const provided = input && typeof input === "object" ? input : {};

  const normalized = {};

  for (const [key, fallbackDepartment] of Object.entries(defaults)) {
    const source = provided[key] || {};

    normalized[key] = {
      key,
      label: safeString(source.label, fallbackDepartment.label),
      permissions: {
        canWarn:
          typeof source?.permissions?.canWarn === "boolean"
            ? source.permissions.canWarn
            : fallbackDepartment.permissions.canWarn,
        canSuspend:
          typeof source?.permissions?.canSuspend === "boolean"
            ? source.permissions.canSuspend
            : fallbackDepartment.permissions.canSuspend,
        canAddNotes:
          typeof source?.permissions?.canAddNotes === "boolean"
            ? source.permissions.canAddNotes
            : fallbackDepartment.permissions.canAddNotes,
        canViewActivity:
          typeof source?.permissions?.canViewActivity === "boolean"
            ? source.permissions.canViewActivity
            : fallbackDepartment.permissions.canViewActivity,
        canManageWebsite:
          typeof source?.permissions?.canManageWebsite === "boolean"
            ? source.permissions.canManageWebsite
            : fallbackDepartment.permissions.canManageWebsite,
      },
      members: Array.isArray(source.members)
        ? [...new Set(source.members.map((id) => String(id).trim()).filter(Boolean))]
        : [],
    };
  }

  return normalized;
}

function getDepartmentAccessForUser(userId, departments) {
  const normalizedUserId = String(userId || "").trim();
  const collection = normalizeDepartmentCollection(departments);

  for (const department of Object.values(collection)) {
    if (department.members.includes(normalizedUserId)) {
      return {
        departmentKey: department.key,
        departmentLabel: department.label,
        permissions: { ...department.permissions },
      };
    }
  }

  return {
    departmentKey: null,
    departmentLabel: "No Department",
    permissions: {
      canWarn: false,
      canSuspend: false,
      canAddNotes: false,
      canViewActivity: false,
      canManageWebsite: false,
    },
  };
}

function formatDepartmentsForClient(departments, members = []) {
  const memberMap = new Map(
    members.map((member) => [
      String(member.userId),
      {
        userId: String(member.userId),
        username: String(member.username || ""),
        displayName: String(member.displayName || ""),
        roleName: String(member.roleName || "Member"),
        roleLabel: String(member.roleLabel || member.roleName || "Member"),
        avatar: String(member.avatar || ""),
      },
    ])
  );

  const normalized = normalizeDepartmentCollection(departments);

  const output = {};

  for (const [key, department] of Object.entries(normalized)) {
    output[key] = {
      key,
      label: department.label,
      permissions: department.permissions,
      members: department.members.map((userId) => {
        const linked = memberMap.get(String(userId));
        return (
          linked || {
            userId: String(userId),
            username: "",
            displayName: `User ${userId}`,
            roleName: "Member",
            roleLabel: "Member",
            avatar: "",
          }
        );
      }),
    };
  }

  return output;
}

async function getWorkspaceSettings(db) {
  const existing = await db.collection("workspaceSettings").findOne({
    groupId: WORKSPACE_CONFIG.groupId,
  });

  const normalizedDepartments = normalizeDepartmentCollection(
    existing?.departments
  );

  return {
    groupId: WORKSPACE_CONFIG.groupId,
    lastMemberSync: existing?.lastMemberSync || null,
    departments: normalizedDepartments,
    createdAt: existing?.createdAt || null,
    updatedAt: existing?.updatedAt || null,
  };
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
        departments: normalizeDepartmentCollection(),
      },
      viewer: {
        inGroup: false,
        roleName: null,
        roleLabel: "Not In Group",
        rank: null,
        departmentKey: null,
        departmentLabel: null,
      },
      permissions: {
        canViewMembers: false,
        canRefreshMembers: false,
        canWarn: false,
        canSuspend: false,
        canAddNotes: false,
        canViewActivity: false,
        canManageWebsite: false,
        canManageSettings: false,
      },
    };
  }

  const db = await getDb();
  const settings = await getWorkspaceSettings(db);

  const canViewMembers = true;

  const canRefreshMembers = hasBoundRole(
    viewerRole.roleName,
    WORKSPACE_CONFIG.refreshRoleBinds || []
  );

  const departmentAccess = getDepartmentAccessForUser(
    user.robloxId,
    settings.departments
  );

  const canManageSettings = canRefreshMembers;

  return {
    workspace: {
      groupId: WORKSPACE_CONFIG.groupId,
      name: WORKSPACE_CONFIG.name,
      lastMemberSync: settings.lastMemberSync,
      departments: settings.departments,
    },
    viewer: {
      inGroup: true,
      roleName: String(viewerRole.roleName || "Member"),
      roleLabel: String(viewerRole.roleName || "Member"),
      rank: Number(viewerRole.rank || 0),
      departmentKey: departmentAccess.departmentKey,
      departmentLabel: departmentAccess.departmentLabel,
    },
    permissions: {
      canViewMembers,
      canRefreshMembers,
      canWarn: !!departmentAccess.permissions.canWarn,
      canSuspend: !!departmentAccess.permissions.canSuspend,
      canAddNotes: !!departmentAccess.permissions.canAddNotes,
      canViewActivity: !!departmentAccess.permissions.canViewActivity,
      canManageWebsite: !!departmentAccess.permissions.canManageWebsite,
      canManageSettings,
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

async function getAllDirectoryMembers(db) {
  return db
    .collection("workspaceMembers")
    .find({
      groupId: WORKSPACE_CONFIG.groupId,
      inDirectory: true,
    })
    .sort({ rank: -1, displayName: 1 })
    .toArray();
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
    username: String(memberDoc.username || ""),
    displayName: String(memberDoc.displayName || ""),
    avatar: String(memberDoc.avatar || ""),
    roleName: String(memberDoc.roleName || "Member"),
    roleLabel: String(memberDoc.roleLabel || memberDoc.roleName || "Member"),
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
    const db = await getDb();
    const members = await getAllDirectoryMembers(db);

    return res.json({
      ok: true,
      workspace: {
        ...access.workspace,
        departments: formatDepartmentsForClient(access.workspace.departments, members),
      },
      viewer: access.viewer,
      permissions: access.permissions,
    });
  } catch (error) {
    console.error("Workspace access error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load workspace access",
    });
  }
});

router.get("/settings", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    const db = await getDb();
    const settings = await getWorkspaceSettings(db);
    const members = await getAllDirectoryMembers(db);

    return res.json({
      ok: true,
      settings: {
        groupId: settings.groupId,
        lastMemberSync: settings.lastMemberSync,
        departments: formatDepartmentsForClient(settings.departments, members),
      },
      permissions: access.permissions,
    });
  } catch (error) {
    console.error("Workspace settings load error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load workspace settings",
    });
  }
});

router.post("/settings/departments/:departmentKey/members", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canManageSettings) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to manage workspace settings",
      });
    }

    const departmentKey = safeString(req.params.departmentKey).toLowerCase();
    const userId = normalizeUserId(req.body?.userId);

    if (!departmentKey || !userId) {
      return res.status(400).json({
        ok: false,
        error: "Department key and userId are required",
      });
    }

    const db = await getDb();
    const settings = await getWorkspaceSettings(db);
    const departments = normalizeDepartmentCollection(settings.departments);

    if (!departments[departmentKey]) {
      return res.status(404).json({
        ok: false,
        error: "Department not found",
      });
    }

    const memberDoc = await getMemberDoc(db, userId);
    if (!memberDoc) {
      return res.status(404).json({
        ok: false,
        error: "Member not found",
      });
    }

    for (const key of Object.keys(departments)) {
      departments[key].members = departments[key].members.filter(
        (id) => String(id) !== userId
      );
    }

    departments[departmentKey].members = [
      ...new Set([...departments[departmentKey].members, userId]),
    ];

    const now = new Date();

    await db.collection("workspaceSettings").updateOne(
      { groupId: WORKSPACE_CONFIG.groupId },
      {
        $set: {
          departments,
          updatedAt: now,
        },
        $setOnInsert: {
          groupId: WORKSPACE_CONFIG.groupId,
          createdAt: now,
        },
      },
      { upsert: true }
    );

    const members = await getAllDirectoryMembers(db);

    return res.json({
      ok: true,
      message: "Member assigned to department",
      departments: formatDepartmentsForClient(departments, members),
    });
  } catch (error) {
    console.error("Assign department member error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to assign member to department",
    });
  }
});

router.delete(
  "/settings/departments/:departmentKey/members/:userId",
  requireAuth,
  async (req, res) => {
    try {
      const access = await requireWorkspaceMemberAccess(req, res);
      if (!access) return;

      if (!access.permissions.canManageSettings) {
        return res.status(403).json({
          ok: false,
          error: "You do not have permission to manage workspace settings",
        });
      }

      const departmentKey = safeString(req.params.departmentKey).toLowerCase();
      const userId = normalizeUserId(req.params.userId);

      const db = await getDb();
      const settings = await getWorkspaceSettings(db);
      const departments = normalizeDepartmentCollection(settings.departments);

      if (!departments[departmentKey]) {
        return res.status(404).json({
          ok: false,
          error: "Department not found",
        });
      }

      departments[departmentKey].members = departments[departmentKey].members.filter(
        (id) => String(id) !== userId
      );

      const now = new Date();

      await db.collection("workspaceSettings").updateOne(
        { groupId: WORKSPACE_CONFIG.groupId },
        {
          $set: {
            departments,
            updatedAt: now,
          },
          $setOnInsert: {
            groupId: WORKSPACE_CONFIG.groupId,
            createdAt: now,
          },
        },
        { upsert: true }
      );

      const members = await getAllDirectoryMembers(db);

      return res.json({
        ok: true,
        message: "Member removed from department",
        departments: formatDepartmentsForClient(departments, members),
      });
    } catch (error) {
      console.error("Remove department member error:", error);
      return res.status(500).json({
        ok: false,
        error: "Failed to remove member from department",
      });
    }
  }
);

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

    const settings = await getWorkspaceSettings(db);
    const departmentCollection = normalizeDepartmentCollection(settings.departments);

    const userDepartmentMap = new Map();

    for (const [key, department] of Object.entries(departmentCollection)) {
      for (const userId of department.members) {
        userDepartmentMap.set(String(userId), {
          departmentKey: key,
          departmentLabel: department.label,
        });
      }
    }

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
      const department = userDepartmentMap.get(String(member.userId)) || null;

      return {
        userId: String(member.userId),
        username: String(member.username || ""),
        displayName: String(member.displayName || ""),
        avatar: String(member.avatar || ""),
        roleName: String(member.roleName || "Member"),
        roleLabel: String(member.roleLabel || member.roleName || "Member"),
        rank: Number(member.rank || 0),
        isConnectedUser:
          String(member.userId) === String(req.session.user.robloxId),
        weeklyActivity,
        weeklyTotalMinutes: totalWeeklyMinutes(weeklyActivity),
        warningCount: warnings.length,
        suspensionCount: suspensions.length,
        noteCount: notes.length,
        departmentKey: department?.departmentKey || null,
        departmentLabel: department?.departmentLabel || null,
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

    if (!access.permissions.canWarn) {
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

router.delete("/members/:userId/warnings/:warningId", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canWarn) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to delete member warnings",
      });
    }

    const userId = normalizeUserId(req.params.userId);
    const warningId = safeString(req.params.warningId);

    if (!userId || !warningId) {
      return res.status(400).json({
        ok: false,
        error: "Missing warning id",
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
        $pull: {
          warnings: { id: warningId },
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    const profile = await buildMemberProfilePayload(db, req, memberDoc);

    return res.json({
      ok: true,
      message: "Warning deleted",
      member: profile,
    });
  } catch (error) {
    console.error("Workspace warning delete error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to delete warning",
    });
  }
});

router.post("/members/:userId/suspensions", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canSuspend) {
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

router.delete("/members/:userId/suspensions/:suspensionId", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canSuspend) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to delete member suspensions",
      });
    }

    const userId = normalizeUserId(req.params.userId);
    const suspensionId = safeString(req.params.suspensionId);

    if (!userId || !suspensionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing suspension id",
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
        $pull: {
          suspensions: { id: suspensionId },
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    const profile = await buildMemberProfilePayload(db, req, memberDoc);

    return res.json({
      ok: true,
      message: "Suspension deleted",
      member: profile,
    });
  } catch (error) {
    console.error("Workspace suspension delete error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to delete suspension",
    });
  }
});

router.post("/members/:userId/notes", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canAddNotes) {
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

router.delete("/members/:userId/notes/:noteId", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canAddNotes) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to delete notes",
      });
    }

    const userId = normalizeUserId(req.params.userId);
    const noteId = safeString(req.params.noteId);

    if (!userId || !noteId) {
      return res.status(400).json({
        ok: false,
        error: "Missing note id",
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
        $pull: {
          notes: { id: noteId },
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    const profile = await buildMemberProfilePayload(db, req, memberDoc);

    return res.json({
      ok: true,
      message: "Note deleted",
      member: profile,
    });
  } catch (error) {
    console.error("Workspace note delete error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to delete note",
    });
  }
});

router.get("/activity/overview", requireAuth, async (req, res) => {
  try {
    const access = await requireWorkspaceMemberAccess(req, res);
    if (!access) return;

    if (!access.permissions.canViewActivity) {
      return res.status(403).json({
        ok: false,
        error: "You do not have permission to view activity",
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
        username: String(member.username || ""),
        displayName: String(member.displayName || ""),
        avatar: String(member.avatar || ""),
        roleName: String(member.roleName || "Member"),
        roleLabel: String(member.roleLabel || member.roleName || "Member"),
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

    const fetchedMembers = await getAllGroupMembers(WORKSPACE_CONFIG.groupId, 100);

    if (!Array.isArray(fetchedMembers) || fetchedMembers.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "Group member fetch returned no valid members",
      });
    }

    const minRank = Number(WORKSPACE_CONFIG.directoryRankMin || 1);
    const maxRank = Number(WORKSPACE_CONFIG.directoryRankMax || 255);

    const normalizedMembers = fetchedMembers
      .map((member) => {
        const userId = String(
          member?.userId ||
            member?.id ||
            member?.user?.userId ||
            member?.user?.id ||
            ""
        ).trim();

        const username =
          member?.username ||
          member?.name ||
          member?.user?.username ||
          member?.user?.name ||
          "";

        const displayName =
          member?.displayName ||
          member?.user?.displayName ||
          username ||
          "";

        const roleName = normalizeRoleName(member);
        const rank = normalizeRank(member);

        return {
          userId,
          username: String(username || ""),
          displayName: String(displayName || ""),
          roleName: String(roleName || "Member"),
          rank,
        };
      })
      .filter((member) => member.userId)
      .filter((member) => member.rank >= minRank && member.rank <= maxRank);

    if (normalizedMembers.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "No valid staff/admin members matched the configured rank range",
      });
    }

    const userIds = normalizedMembers
      .map((member) => Number(member.userId))
      .filter((id) => Number.isFinite(id));

    const avatarMap = await getAvatarHeadshots(userIds);
    const now = new Date();

    const memberOps = normalizedMembers.map((member) => ({
      updateOne: {
        filter: {
          groupId: WORKSPACE_CONFIG.groupId,
          userId: member.userId,
        },
        update: {
          $set: {
            groupId: WORKSPACE_CONFIG.groupId,
            userId: member.userId,
            username: member.username,
            displayName: member.displayName,
            avatar: String(avatarMap?.[member.userId] || ""),
            roleName: member.roleName,
            roleLabel: member.roleName,
            rank: Number(member.rank || 0),
            inDirectory: true,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        upsert: true,
      },
    }));

    await db.collection("workspaceMembers").bulkWrite(memberOps);

    const profileOps = normalizedMembers.map((member) => ({
      updateOne: {
        filter: {
          groupId: WORKSPACE_CONFIG.groupId,
          userId: member.userId,
        },
        update: {
          $setOnInsert: {
            groupId: WORKSPACE_CONFIG.groupId,
            userId: member.userId,
            weeklyActivity: createDefaultWeeklyActivity(),
            warnings: [],
            suspensions: [],
            notes: [],
            createdAt: now,
          },
          $set: {
            updatedAt: now,
          },
        },
        upsert: true,
      },
    }));

    await db.collection("workspaceMemberProfiles").bulkWrite(profileOps);

    await db.collection("workspaceMembers").updateMany(
      {
        groupId: WORKSPACE_CONFIG.groupId,
        userId: {
          $nin: normalizedMembers.map((member) => member.userId),
        },
      },
      {
        $set: {
          inDirectory: false,
          updatedAt: now,
        },
      }
    );

    const existingSettings = await getWorkspaceSettings(db);

    await db.collection("workspaceSettings").updateOne(
      {
        groupId: WORKSPACE_CONFIG.groupId,
      },
      {
        $set: {
          lastMemberSync: now,
          departments: existingSettings.departments,
          updatedAt: now,
        },
        $setOnInsert: {
          groupId: WORKSPACE_CONFIG.groupId,
          createdAt: now,
        },
      },
      { upsert: true }
    );

    return res.json({
      ok: true,
      message: "Members refreshed successfully",
      count: normalizedMembers.length,
      lastMemberSync: now,
    });
  } catch (error) {
    console.error("Workspace refresh members error:", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Failed to refresh members",
    });
  }
});

module.exports = router;