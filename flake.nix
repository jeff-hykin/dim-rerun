{
    description = "Rerun (dim-rerun), a dimOS Desktop app: `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + built React frontend)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };
    outputs = { self, nixpkgs }:
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
            packages = forAll (pkgs: rec {
                frontend = pkgs.buildNpmPackage {
                    pname = "rerun-frontend";
                    version = "0.1.0";
                    src = ./frontend;
                    # `nix build .#frontend` prints the right hash when package-lock.json changes
                    npmDepsHash = "sha256-brElOtMPxIUk3jCtu9qidZVh3L+ZkomQe7V7ydr2dYA=";
                    installPhase = "cp -r dist $out";
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
