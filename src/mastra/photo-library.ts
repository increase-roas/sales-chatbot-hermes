// Source of truth for the bot's photo library. scripts/*.py read the JSON between the markers.
// LIBRARY-JSON-START
const library = {
  "source": "Alex's uploads 2026-10-15, bot-photos-20261015/inbox; send-safe copies (house numbers and plates blurred) in bot-photos-20261015/library via scripts/process-photos.py",
  "consent": "Alex confirmed 2026-10-15 that every homeowner is fine with their photo being shown (Director relay: 'i confirm all photos are ok with it being shown').",
  "excluded": [
    "alex-upload-05 (review screenshot with customer PII: quote text only)",
    "alex-upload-06 (not an install)"
  ],
  "review_quote": {
    "text": "LOOOOVE my lights !!!! soo pretty and very professionally installed ! this is my 2nd year !!",
    "attribution": "a customer in Troy",
    "score": "10/10"
  },
  "photos": [
    {
      "id": "rooftop-01",
      "file": "dyn-rooftop-install-01.jpg",
      "colors": [],
      "styles": [
        "install",
        "safety"
      ],
      "house": "colonial",
      "features": [
        "roofline clips",
        "rooftop view"
      ],
      "consent": "granted",
      "hook": "we do the ladder part so you don't",
      "kind": "install"
    },
    {
      "id": "warmwhite-colonial-02",
      "file": "dyn-warmwhite-brick-colonial-02.jpg",
      "colors": [
        "warm white"
      ],
      "styles": [
        "classic"
      ],
      "house": "brick colonial",
      "features": [
        "roofline",
        "wreaths"
      ],
      "consent": "granted",
      "hook": "warm white roofline with wreaths",
      "kind": "install"
    },
    {
      "id": "warmwhite-bushes-03",
      "file": "dyn-warmwhite-roofline-bushes-03.jpg",
      "colors": [
        "warm white"
      ],
      "styles": [
        "classic"
      ],
      "house": "brick ranch",
      "features": [
        "roofline",
        "bushes"
      ],
      "consent": "granted",
      "hook": "warm white roofline plus the bushes",
      "kind": "install"
    },
    {
      "id": "multicolor-04",
      "file": "dyn-multicolor-roofline-columns-04.jpg",
      "colors": [
        "multicolor"
      ],
      "styles": [
        "fun"
      ],
      "house": "brick colonial",
      "features": [
        "roofline",
        "door columns"
      ],
      "consent": "granted",
      "hook": "multicolor roofline and door columns",
      "kind": "install"
    },
    {
      "id": "rooftop-07",
      "file": "dyn-rooftop-install-07.jpg",
      "colors": [],
      "styles": [
        "install",
        "safety"
      ],
      "house": "ranch",
      "features": [
        "roofline clips",
        "rooftop view"
      ],
      "consent": "granted",
      "hook": "the view from our office today",
      "kind": "install"
    },
    {
      "id": "redgreen-08",
      "file": "dyn-redgreen-roofline-uplights-08.jpg",
      "colors": [
        "red",
        "green"
      ],
      "styles": [
        "bold"
      ],
      "house": "two story",
      "features": [
        "roofline",
        "uplights",
        "landscape"
      ],
      "consent": "granted",
      "hook": "red and green roofline with uplights",
      "kind": "install"
    },
    {
      "id": "red-09",
      "file": "dyn-red-roofline-09.jpg",
      "colors": [
        "red"
      ],
      "styles": [
        "bold"
      ],
      "house": "brick ranch",
      "features": [
        "roofline"
      ],
      "consent": "granted",
      "hook": "all red roofline",
      "kind": "install"
    },
    {
      "id": "warmwhite-modern-10",
      "file": "dyn-warmwhite-modern-white-brick-10.jpg",
      "colors": [
        "warm white"
      ],
      "styles": [
        "modern"
      ],
      "house": "white brick modern",
      "features": [
        "roofline",
        "bushes",
        "wreath"
      ],
      "consent": "granted",
      "hook": "warm white on a white brick house",
      "kind": "install"
    },
    {
      "id": "warmwhite-garage-11",
      "file": "dyn-warmwhite-garage-outline-11.jpg",
      "colors": [
        "warm white"
      ],
      "styles": [
        "classic"
      ],
      "house": "brick two story",
      "features": [
        "roofline",
        "garage doors",
        "sign"
      ],
      "consent": "granted",
      "hook": "warm white with the garage doors outlined",
      "kind": "install"
    },
    {
      "id": "rooftop-high-14",
      "file": "dyn-rooftop-high-14.jpg",
      "colors": [],
      "styles": [
        "install",
        "safety"
      ],
      "house": "ranch",
      "features": [
        "roofline clips",
        "rooftop view"
      ],
      "consent": "granted",
      "kind": "install",
      "sameImageAs": "rooftop-07",
      "hook": "way up high on the roof",
      "captions": {
        "manny": [
          "this was the other day!",
          "up top the other day, view was great lol"
        ],
        "other": [
          "manny loves getting on the roof!",
          "manny was up here the other day, he loves it"
        ]
      }
    }
  ],
  "rapport": [
    {
      "id": "rapport-colombia-12",
      "file": "dyn-rapport-manny-colombia-12.jpg",
      "consent": "granted",
      "kind": "rapport",
      "seed": "thats me in colombia with my wife! she's from colombia. they don't know there but they do have a lot of light installs haha",
      "speaker": "manny"
    },
    {
      "id": "rapport-channel4-13",
      "file": "dyn-rapport-manny-channel4-13.jpg",
      "consent": "granted",
      "kind": "rapport",
      "seed": "my old company got us on channel 4! maybe one day we get on the news for holiday lights",
      "speaker": "manny"
    }
  ]
}
// LIBRARY-JSON-END
export default library
