# Keep a session in use signed in

An application session lasts 400 days from its last renewal, and each bootstrap renews it, at most once a day, by moving both the Control D1 expiry and the cookie's `Max-Age` a full 400 days forward. A session that is opened at least once every 400 days therefore never expires; only logging out on that device, or 400 days without opening the GUI, ends it.

The previous fixed seven days from login signed every device out a week after its sign-in, however often it was used, which read as one device's login ending another's. Four hundred days is the longest a browser keeps a cookie, so a longer server-side lifetime would only be cut short by the browser. Renewal rides on bootstrap because every page load already calls it, and a daily bound keeps it to one Control D1 write per device per day.

The cost is that a stolen session cookie stays valid for as long as it is used. Logging out revokes a session server side, but only from the device that holds it; there is not yet a list of sessions from which a lost device could be signed out elsewhere.
