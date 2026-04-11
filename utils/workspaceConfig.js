const FLOURAI_GROUP_ID = Number(process.env.FLOURAI_GROUP_ID || "14811541");

const WORKSPACE_CONFIG = {
  groupId: FLOURAI_GROUP_ID,
  name: "Flourai Panel",
  directoryRoleBinds: [
    "Leadership",
    "Management",
    "Staff",
    "Sessions",
    "Moderation",
  ],
  refreshRoleBinds: ["Leadership", "Management"],
};

module.exports = {
  WORKSPACE_CONFIG,
};