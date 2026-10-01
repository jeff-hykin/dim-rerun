# dim-rerun

A [DimOS dashboard](https://github.com/jeff-hykin/dim-app) app that embeds the
**[Rerun](https://rerun.io) web viewer** right in the desktop, so you can watch a
live Rerun stream without leaving DimOS.

Enter the host/port of a running Rerun web viewer and it renders in an inner
frame. It auto-connects to the last-used (or default `localhost:9090`) on open.

## How it works

Frontend-only — there's no backend. The page is a thin shim: it builds the
viewer URL and points an inner iframe at it. For a bare `host:port` it appends
Rerun's default data proxy (`:9876`) so `rerun --serve-web` just works; paste a
full URL with your own `?url=` to override.

## Usage

Start a viewer and connect:

```sh
rerun --serve-web        # web viewer on :9090, data proxy on :9876
```

Then open the Rerun app in the dashboard and hit Connect.

## Install

```sh
dim install https://github.com/jeff-hykin/dim-rerun
```

The app appears in the dashboard rail within a few seconds.

## dimOS Desktop

On the new (Rust) dimOS Desktop:

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-rerun --ref dimos-desktop2
```

The package is described by `dimos.yaml`; its install step (`nix run .#install`) just checks the frontend files.

## Layout

```
dim/apps/rerun/
  app.yaml        title
  frontend/
    icon.svg      rail icon
    index.html    the viewer shim (frontend-only)
```

Licensed under Apache-2.0.
