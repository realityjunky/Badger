# Personal WeCom robots and notification routes

Badger treats WeCom long-connection robots as personal delivery endpoints. A
signed-in person may register several encrypted robots and route each
notification event to one selected robot at workflow, Group, or all-my-work
scope, with workflow taking precedence over Group and Group over all-work.
The Badger inbox remains the fallback and the authority for sign-off; robots
never grant Badger capabilities. The WeCom CLI is an optional assistant client
and is not the Badger worker or its credential store.
