{
    description = "dim-rerun: the Rerun web viewer as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            apps = forAllSystems (pkgs: {
                # frontend-only, nothing to build: check the page and icon are there and the icon parses
                install = {
                    type = "app";
                    program = toString (pkgs.writeShellScript "install" ''
                        set -e
                        app=dim/apps/rerun/frontend
                        test -s "$app/index.html"
                        ${pkgs.libxml2}/bin/xmllint --noout "$app/icon.svg"
                        echo "dim-rerun: frontend ok"
                    '');
                };
            });
        };
}
