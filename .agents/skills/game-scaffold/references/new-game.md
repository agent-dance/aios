# New-game workflow

## Scaffold first

For a new game, the first implementation write must be this command from the repository root:

```powershell
npm run game:create -- --id <lowercase-kebab-id> --name "<Display Name>"
```

- Implement directly from the generated `src/apps/<id>` directory. Do not hand-create a game directory or assemble a substitute template first.
- Do not copy `src/apps/space-game` or another game as a template. Existing games may inform gameplay or visuals, never infrastructure.
- The CLI supports only `--id` and `--name`. Do not bypass reserved-name, path, conflict, no-overwrite, or atomic-creation safeguards.
- Gameplay, scene, UI, input mapping, and renderer content may change after generation, but the shared platform boundaries and runtime contract must remain.

## Explicit product registration

The generator intentionally does not mutate product registration. Complete and verify:

1. Add the id to `AppId` in `src/system/types.ts`.
2. Add metadata to `APP_REGISTRY` in `src/system/appRegistry.ts`.
3. Add it to `DOCK_APPS` only when product requirements explicitly call for it.
4. Lazy-import the application in `src/App.tsx`.
5. Register it in `appContents` and forward the shell's `isActive` value.
6. If it must appear in App Store, update the listing and icon mapping in `src/apps/store/AppStoreApp.tsx`.
7. Verify icon, default-window policy, Dock policy, and lazy chunk boundaries.
