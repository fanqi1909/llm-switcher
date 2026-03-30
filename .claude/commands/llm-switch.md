Switch LLM session via the llm-switcher proxy running on localhost:8411.

If "$ARGUMENTS" is provided, switch to that session:
- Run: `curl -s -X POST http://localhost:8411/admin/switch/$ARGUMENTS`
- Confirm the switch result to the user.

If no argument is provided:
1. List available sessions: `curl -s http://localhost:8411/admin/sessions`
2. Show them in a table and ask which one to switch to.
3. Once the user picks one, run `curl -s -X POST http://localhost:8411/admin/switch/<name>` to switch.
