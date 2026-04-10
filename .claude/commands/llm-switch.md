Switch THIS chat's LLM session via the llm-switcher proxy running on localhost:8411.

This binds the current chat window to a specific session — other chat windows are not affected.

If "$ARGUMENTS" is `statusline on`:
1. Read `.claude/settings.local.json` in the current project if it exists.
2. Merge this `statusLine` config into it without overwriting other keys:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "llm-switcher statusline",
       "padding": 2
     }
   }
   ```
3. Write the updated JSON back to `.claude/settings.local.json`.
4. Confirm that project-local statusline is enabled for the current repo.

If "$ARGUMENTS" is `statusline off`:
1. Read `.claude/settings.local.json` in the current project if it exists.
2. Remove only the `statusLine` field.
3. Write the updated JSON back, preserving other keys.
4. Confirm that project-local statusline is disabled for the current repo.

If "$ARGUMENTS" is provided and is not a `statusline ...` subcommand, switch this chat to that session:
1. Get this chat's ID: `curl -s http://localhost:8411/admin/recent-chat-id`
2. If a `chat_session_id` is returned, bind it: `curl -s -X POST "http://localhost:8411/admin/chat-bind/<chat_session_id>/$ARGUMENTS"`
3. Confirm the result to the user, e.g. "This chat is now using session '$ARGUMENTS'."
4. If no chat ID is found (proxy hasn't seen a request from this chat yet), tell the user to try again after sending a message.

If no argument is provided:
1. List available sessions: `curl -s http://localhost:8411/admin/sessions`
2. Show them in a table and ask which one to switch to.
3. Once the user picks one, follow the steps above to bind this chat to that session.
If the user asks for statusline state with no `on`/`off`, inspect `.claude/settings.local.json` and report whether `statusLine.command` is set to `llm-switcher statusline`.
