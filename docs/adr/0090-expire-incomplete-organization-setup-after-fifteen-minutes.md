# Expire incomplete Organization setup after fifteen minutes

After the complete Automation Inbox grant returns, the setup session remains valid for fifteen minutes while the installer registers the initial Owner passkey.

If passkey registration is not completed within that window, Mail Automation attempts to revoke the Google grant, deletes every locally held access or refresh token and pending setup secret, and creates no Organization D1 database. A later attempt starts a new OAuth flow rather than reviving the expired setup.
