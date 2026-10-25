{
    description = "Rerun (dim-rerun), a dimOS Desktop app: `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + built React frontend)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    # the page's deno: nixos-25.11's 2.6.10, the version dimos pins (newer deno refuses packages younger than a day)
    inputs.nixpkgs-deno.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };
    outputs = { self, nixpkgs, nixpkgs-deno }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
            # bin/dimos-app-server for <arch> Linux, written on any machine: its bash and deno are the target's (cache.nixos.org downloads, nothing built)
            linuxApp = pkgs: arch: line:
                let linux = nixpkgs.legacyPackages."${arch}-linux"; in
                pkgs.writeTextFile {
                    name = "dimos-app-server-${arch}-linux";
                    destination = "/bin/dimos-app-server";
                    executable = true;
                    text = "#!${linux.runtimeShell}\n${line linux}\n";
                };
        in {
            packages = forAll (pkgs:
                let
                    system = pkgs.stdenv.hostPlatform.system;
                    pageDeno = nixpkgs-deno.legacyPackages.${system}.deno;
                    denoEnv = "export HOME=$TMPDIR DENO_DIR=$TMPDIR/deno DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1";
                    frontendFiles = paths: pkgs.lib.fileset.toSource { root = ./frontend; fileset = pkgs.lib.fileset.unions paths; };
                    pageFiles = frontendFiles [ ./frontend/deno.json ./frontend/deno.lock ./frontend/index.html ./frontend/vite.config.ts ./frontend/tools ./frontend/src ];
                in rec {
                # `deno install --frozen` (deno.lock pins every package) with network, so fixed-output. Its hash is per
                # build machine (vite's native rollup and esbuild differ by OS and CPU): `deno task update-hashes` refreshes
                # this machine's after frontend/deno.json or deno.lock change.
                frontendModules = pkgs.stdenvNoCC.mkDerivation {
                    name = "rerun-frontend-modules";
                    src = frontendFiles [ ./frontend/deno.json ./frontend/deno.lock ];
                    nativeBuildInputs = [ pageDeno ];
                    buildPhase = ''
                        ${denoEnv}
                        export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
                        deno install --frozen
                        # deno's own record of the install: not needed, and not byte-identical between installs
                        rm -f node_modules/.deno/.setup-cache.bin
                    '';
                    installPhase = "cp -R node_modules $out";
                    dontFixup = true;
                    outputHashMode = "recursive";
                    outputHashAlgo = "sha256";
                    outputHash = {
                        aarch64-darwin = "sha256-Ac0wOBFaE5Wpe92YVw5aEVc+83vcIzyGy5atAMzJNnA=";
                        x86_64-darwin = "";
                        x86_64-linux = "sha256-/zH7C4Q4UkV0OqwweqoysC2NkUlQBFwvzpJ4aWv4G9A=";
                        aarch64-linux = "";
                    }.${system};
                };
                # dimos-react's source at its tag (frontend/tools/esm_fetch.ts): a vite build with network that
                # keeps only what it fetched, so fixed-output; the same on every system. `deno task update-hashes` refreshes it.
                frontendEsm = pkgs.stdenvNoCC.mkDerivation {
                    name = "rerun-frontend-esm";
                    src = pageFiles;
                    nativeBuildInputs = [ pageDeno ];
                    buildPhase = ''
                        ${denoEnv}
                        export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
                        cp -R ${frontendModules} node_modules
                        chmod -R u+w node_modules
                        ESM_CACHE=$TMPDIR/esm deno run -A --cached-only --node-modules-dir=manual npm:vite build --logLevel warn
                    '';
                    installPhase = "cp -R $TMPDIR/esm $out";
                    dontFixup = true;
                    outputHashMode = "recursive";
                    outputHashAlgo = "sha256";
                    outputHash = "sha256-utsCgw1Bc1BFp4xFzysHymcAMGFGaNG6fVLiA01WBeo=";
                };
                # the page: React + Vite against those modules and that dimos-react cache, offline
                frontend = pkgs.stdenvNoCC.mkDerivation {
                    name = "rerun-frontend";
                    src = pageFiles;
                    nativeBuildInputs = [ pageDeno ];
                    buildPhase = ''
                        ${denoEnv}
                        cp -R ${frontendModules} node_modules
                        chmod -R u+w node_modules
                        ESM_CACHE=${frontendEsm} ESM_OFFLINE=1 deno run -A --cached-only --node-modules-dir=manual npm:vite build
                    '';
                    installPhase = "cp -R dist $out";
                };
                dimosApp = pkgs.writeShellScriptBin "dimos-app-server" ''
                    exec ${pkgs.deno}/bin/deno run -A --no-lock ${./backend}/main.ts --frontend ${frontend} "$@"
                '';
                default = dimosApp;
                # the frontend is plain JS, so the same build serves every target
                dimosApp-aarch64-linux = linuxApp pkgs "aarch64" (linux: "exec ${linux.deno}/bin/deno run -A --no-lock ${./backend}/main.ts --frontend ${frontend} \"$@\"");
                dimosApp-x86_64-linux = linuxApp pkgs "x86_64" (linux: "exec ${linux.deno}/bin/deno run -A --no-lock ${./backend}/main.ts --frontend ${frontend} \"$@\"");
            });
        };
}
