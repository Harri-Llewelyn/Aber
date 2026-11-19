### From 1.9.0, the dashboard's and Node-RED's images are built with `licenses/`

The release's images need nothing. A site that builds Aber's images itself adds one flag to two
builds, the dashboard's and Node-RED's. That is an arm64 or air-gapped site following
[*Images you must build*](../../deploy/k8s/README.md#images-you-must-build). Run both builds from the
repository root, with `NS` and `V` set as that section sets them:

```bash
docker build -f node-red/Dockerfile --build-context licenses=./licenses \
                                                -t $NS/node-red:$V node-red
docker build -f frontend/Dockerfile --build-arg VITE_RUNTIME_CONFIG=true \
                                    --build-arg VITE_APP_VERSION=$V \
                                    --build-context help=./help \
                                    --build-context licenses=./licenses \
                                                -t $NS/frontend:$V frontend
```

Without `--build-context licenses=./licenses`, the build stops with `pull access denied` for
`licenses`. Both images now list the licences of their operating system's packages under
`/usr/share/licenses/`, as every Alpine-based image Aber publishes does
([`NOTICE.md`](../../NOTICE.md)). The script that writes the list is in `licenses/`.
