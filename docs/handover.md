# Packaging a hand-off

> Read this before copying, archiving or otherwise transferring a working tree to anyone else.
> The secrets this repository generates are untracked, so the usual "is the tree clean?" check
> does not see them.

```bash
npm run dev:down && git status    # delete the k3d cluster, confirm the tree is clean
```

**`git status` clean is not the same as safe to hand over**, and the gap is the point of this
document. Everything below is deliberately untracked -- it is generated, per-machine, or secret --
so a clean tree says nothing about it, and a hand-off packaged as an archive or a copied
directory carries all of it.

| Purge | Holds |
| :--- | :--- |
| `backups/` | Logical dumps from `scripts/backup-databases.sh`: `auth.users` bcrypt hashes, OAuth client secret hashes, every audit row |
| `deploy/helm/acs-cymru/values-local.yaml` | Every credential `npm run setup` minted, including `serviceRoleKey` and `jwtSecret` |
| `frontend/dist/` | A built bundle carrying whichever `VITE_*` values were baked at build time |
| The k3d cluster | Both databases, the broker's CA **private key** (a cert-manager Secret; it is in every Remote gateway's trust store, and re-minting it takes the fleet offline silently), the forge and the backups PVC. `npm run dev:down` deletes all of it |

```bash
npm run dev:down
rm -rf backups/ deploy/helm/acs-cymru/values-local.yaml frontend/dist/
```

The recipient runs `npm run setup` themselves: that is what makes the credentials theirs rather
than a copy of yours. It asks for the domain Remote gateways reach their machine on; blank is
accepted and means remote gateways cannot be enrolled until `global.publicBaseDomain` is set.
`values-dev.yaml` carries published demonstration secrets so the stack still starts without a
local file, which is a convenience and **not** a supported state for anything another person can
reach.
