function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({
      ok: false,
      error: "Not logged in",
    });
  }

  next();
}

module.exports = requireAuth;