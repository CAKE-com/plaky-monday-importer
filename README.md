# Monday to Plaky Migrator

Copies your monday.com boards into Plaky: groups, items, subitems, people, updates and files. Nothing in monday.com is changed.

## What you need

- [bun](https://bun.sh) and [Node.js](https://nodejs.org) installed on your computer
- Your monday.com API token: in monday.com, click your picture, then **Developers**, then **My access tokens**
- Your Plaky API key: in Plaky, click your picture, then **Profile settings**, then **API**

## Start the app

1. Open Terminal in this folder.
2. Type `bun install --frozen-lockfile` and press Enter.
3. Type `bun run build` and press Enter.

The app opens in your browser. Keep the Terminal window open while you work. When you are done, click in Terminal and press Ctrl+C.

## Move your boards

1. **Connect**: paste your monday.com token and your Plaky key, then click **Connect**.
2. **Choose**: tick the boards you want, pick the Plaky Space, then click **Read**.
3. **Set up in Plaky**: download the setup files. In Plaky, import each one (**+**, **New Board**, **Create from file**) and set the field types the page lists.
4. **Move**: click **Move**.
5. **Check**: when every board shows **Match**, save the report.

## Your data

Your keys and boards stay on this computer, in the file `data/monday-to-plaky-migrator.db`. To remove a migration, open it, then **Advanced tools**, then **Erase this migration's data**. When you stop the app and every migration is finished, the app erases them all.

## License

[MIT](LICENSE)
