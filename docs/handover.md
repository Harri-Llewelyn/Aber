# Packaging a hand-off

> Read this before copying, archiving or otherwise transferring a working tree to anyone else.
> The secrets this repository generates are untracked, so the usual "is the tree clean?" check
> does not see them.

```bash
npm run dev:down && git status    # delete the k3d cluster, confirm the tree is clean
```

**`git status` clean is not the same as safe to hand over**, and the gap is the point of this
document. Everything below is deliberately untracked — it is generated, per-machine, or secret —
so a clean tree says nothing about it, and a hand-off packaged as an archive or a copied
directory carries all of it.

| Purge | Holds |
| :--- | :--- |
| `backups/` | Full logical dumps from `scripts/backup-databases.sh` — `auth.users` bcrypt hashes, OAuth client secret hashes, every audit row |
| `.env` | All 24 generated credentials, including `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_JWT_SECRET` |
| `mosquitto_certs` volume | The internal CA **private key**. Distributed to every physical gateway's trust store — re-minting it takes the fleet offline silently |
| `frontend/dist/` | A built bundle carrying whichever `VITE_*` values were baked at build time |

```bash
rm -rf backups/ .env frontend/dist/
npm run setup                           # regenerate .env for the recipient
```

The recipient runs `npm run setup` themselves — that is what makes the credentials theirs rather
than a copy of yours. It asks for the hostname physical gateways reach their machine on; blank is
accepted and means remote gateways cannot be enrolled until it is set. `.env.example` carries working development secrets so the stack still starts
without it, which is a convenience and **not** a supported state for anything another person can
reach.
