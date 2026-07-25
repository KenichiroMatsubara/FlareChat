# Run the private pilot as an unverified production OAuth app

The initial private deployment configures its Google OAuth application as `External / In production` without completed sensitive or restricted scope verification. Organization creation requires a successful complete Automation Inbox grant under ADR 0088.

This accepts Google's unverified-app consent warning and lifetime new-user cap. It rejects OAuth Testing mode because Gmail authorization and its refresh token would expire after seven days, which is incompatible with unattended operation.

This decision applies only to the private pilot. General public onboarding requires Google verification and any security assessment applicable to server-side handling of restricted Gmail data.
