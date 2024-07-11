import "dotenv/config";
import { RecentTracks } from "scrobbles";
import SpotifyWebApi from "spotify-web-api-node";
import express from "express";
import superagent from "superagent";
import readline from "readline";
import cron from "node-cron";
import fs from "fs";

const PORT = process.env.PORT || 8888;
const app = express();

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});

async function getDailyListenings() {
  const reader = new RecentTracks({
    user: process.env.LASTFM_USER,
    apikey: process.env.LASTFM_API_KEY,
    from: Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000),
    extended: true,
    mapTrack: (rawTrack) => ({
      date: Number(rawTrack.date.uts),
      artist: rawTrack.artist.name,
      name: rawTrack.name,
      album: rawTrack.album["#text"],
      url: rawTrack.url,
    }),
  });

  const songs = [];
  for await (const page of reader) {
    songs.push(...page);
  }

  return songs;
}

function getMostListenedSongs(songs) {
  const counts = songs.reduce((acc, song) => {
    acc[song.name] = (acc[song.name] || 0) + 1;
    return acc;
  }, {});

  const sortedSongs = Object.entries(counts)
    .map(([song, count]) => ({
      song,
      artist: songs.find((s) => s.name === song).artist,
      album: songs.find((s) => s.name === song).album,
      url: songs.find((s) => s.name === song).url,
      count,
    }))
    .sort((a, b) => b.count - a.count);

  return sortedSongs;
}

async function getNewAccessToken() {
  spotifyApi.refreshAccessToken().then(
    function (data) {
      console.log("[+] refreshed access token");
      spotifyApi.setAccessToken(data.body["access_token"]);
    },
    function (err) {
      console.log("[!] could not refresh access token");
      console.error(err);
    }
  );
}

function dailyRequest() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    console.error("[!] missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET");
    return;
  }

  if (spotifyApi.getAccessToken() === null) {
    console.error("[!] access token is null");
    return;
  }

  if (spotifyApi.getRefreshToken() === null) {
    console.error("[!] refresh token is null");
    return;
  }

  console.log("[?] making daily request");
  superagent.get("http://localhost:8888/daily").end((err, res) => {
    if (err) {
      console.log("[!] daily request failed");
      console.error(err);
      return;
    } else {
      console.log("[+] daily request completed successfully");
      return;
    }
  });
}

async function getCodes(code) {
  try {
    console.log("[?] getting access token");
    const data = await spotifyApi.authorizationCodeGrant(code);
    console.log("[+] got access token successfully");
    const { access_token, refresh_token } = data.body;

    console.log("[+] set access token and refresh token");
    spotifyApi.setAccessToken(access_token);
    spotifyApi.setRefreshToken(refresh_token);

    fs.writeFileSync("token.json", JSON.stringify(data.body));
  } catch (error) {
    console.error(error);
  }
}

function createUrl() {
  let url = spotifyApi.createAuthorizeURL(
    ["playlist-modify-public", "playlist-modify-private", "playlist-read-private"],
    "state",
    false,
    "code"
  );
  console.log("[+] open this URL in your browser and authorize the app");
  console.log(url);
  console.log("[?] enter the code from the URL");
}

async function question(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      return resolve(answer);
    });
  });
}

app.get("/callback", async (req, res) => {
  res.json({ code: req.query.code ? req.query.code : "no code provided" });
});

app.get("/daily", async (req, res) => {
  try {
    await getNewAccessToken();
    console.log("[?] getting daily listenings");
    let listenings = await getDailyListenings();
    console.log("[+] got daily listenings");

    console.log("[+] sorting songs");
    const sortedSongs = getMostListenedSongs(listenings);
    console.log(
      `[+] sorted songs: ${sortedSongs.length} - most listened song: ${sortedSongs[0].song} with count ${sortedSongs[0].count}`
    );

    console.log("[?] getting playlist");
    const playlist = await spotifyApi.getPlaylist(process.env.SPOTIFY_PLAYLIST_ID);
    console.log("[+] got playlist");

    let songToAdd = null;
    for (let songInfo of sortedSongs) {
      console.log(`[?] searching for song ${songInfo.song} by ${songInfo.artist}`);
      const findSong = await spotifyApi.searchTracks(`track:${songInfo.song} artist:${songInfo.artist}`);
      const song = findSong.body.tracks.items.find((song) => song.name === songInfo.song);

      if (!song) {
        console.log(`[!] song ${songInfo.song} not found on spotify`);
        console.log(`[!] skipping song`);
        continue;
      }

      console.log(`[+] found song ${songInfo.song} by ${songInfo.artist}`);
      console.log(`[?] checking if song ${song.name} by ${song.artists[0].name} is already in the playlist`);
      const songInPlaylist = playlist.body.tracks.items.find((playlistSong) => playlistSong.track.name === song.name);

      if (!songInPlaylist) {
        console.log(`[+] song ${song.name} by ${song.artists[0].name} is not in the playlist`);
        songToAdd = song;
        break;
      } else {
        console.log(`[-] song ${song.name} by ${song.artists[0].name} is already in the playlist`);
      }
    }

    if (!songToAdd) {
      console.log(`[-] all songs are already in the playlist`);
      res.json({ success: false, message: "All songs are already in the playlist" });
      return;
    }

    console.log(`[+] adding song ${songToAdd.name} by ${songToAdd.artists[0].name} to playlist`);
    const addToPlaylist = await spotifyApi.addTracksToPlaylist(process.env.SPOTIFY_PLAYLIST_ID, [songToAdd.uri]);
    if (addToPlaylist.statusCode !== 201) {
      console.log(`[!] failed to add song ${songToAdd.name} by ${songToAdd.artists[0].name} to playlist`);
      throw new Error("Failed to add song to playlist");
    }

    console.log(`[+] successfully added song ${songToAdd.name} by ${songToAdd.artists[0].name} to playlist`);
    res.json({ success: true });
  } catch (error) {
    res.json({ error: error.message });
    console.error(error);
  }
});

app.listen(PORT, async () => {
  console.log("[+] server is running on http://localhost:" + PORT);

  let data = JSON.parse(fs.readFileSync("token.json"));

  if (data["access_token"] && data["refresh_token"]) {
    spotifyApi.setAccessToken(data["access_token"]);
    spotifyApi.setRefreshToken(data["refresh_token"]);
    spotifyApi.refreshAccessToken().then(
      function (data) {
        console.log("[+] refreshed access token");
        spotifyApi.setAccessToken(data.body["access_token"]);
        if (data.body["refresh_token"]) {
          spotifyApi.setRefreshToken(data.body["refresh_token"]);
          fs.writeFileSync("token.json", JSON.stringify(data.body));
        }
      },
      async function (err) {
        console.log("[!] could not refresh access token");
        createUrl();
        let code = await question("[?] code: ");
        console.log("[+] got code");
        await getCodes(code);
      }
    );
  } else {
    createUrl();
    let code = await question("[?] code: ");
    console.log("[+] got code");
    await getCodes(code);
  }

  cron.schedule("0 0 * * *", async () => {
    try {
      dailyRequest();
    } catch (e) {
      console.error(e);
    }
  });
});
