{
    description = "dim-rerun: the Rerun web viewer as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            packages = forAllSystems (pkgs: {
                # a static page, served at /apps/<name>/; the rail icon rides along for the page's own use
                dimosApp = pkgs.runCommand "dim-rerun" { } ''
                    cp -r ${self}/dim/apps/rerun/frontend $out
                    chmod -R u+w $out
                    cp ${self}/icon.svg $out/icon.svg
                    test -s $out/index.html
                    ${pkgs.libxml2}/bin/xmllint --noout $out/icon.svg
                '';
            });
        };
}
