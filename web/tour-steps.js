// The guided tour, one stop per entry.
//
//   target  a CSS selector. A stop whose target is missing or hidden is
//           skipped, so stops for things this account cannot see (Render
//           without the grant, an owner-only button, an image-only control
//           while a video model is picked) drop out on their own.
//   title   a few words
//   text    one or two sentences
//
// Wording only: change it freely, nothing else reads it. Never name a model
// here; the list of models comes from the registry and changes without a
// code change (see CLAUDE.md, "The frontend never hardcodes a model").

export const TOUR_STEPS = [
  {
    target: '#type-toggle',
    title: 'Image or video',
    text: 'Pick what you are making. The model list next to it follows this choice.',
  },
  {
    target: '#model-select',
    title: 'Target model',
    text: 'The model you will paste the prompt into. Each one gets its own builder and its own way of writing: tags for some, prose or timed shots for others. Switching clears the output.',
  },
  {
    target: '#prompt-llm-select',
    title: 'Written by',
    text: 'The local LLM that writes your prompt. Model notes, beside it, is where everyone shares what each one is good at.',
  },
  {
    target: '#builder-mount [data-bind="brief"]',
    title: 'Your brief',
    text: 'Say what you want in your own words. Rough is fine; turning it into the model\'s dialect is the job.',
  },
  {
    target: '#builder-mount [data-bind="slider_block"]',
    title: 'Details and Creativity',
    text: 'Details sets how long and specific the prompt gets. Creativity sets how far past your brief the model may go.',
  },
  // The image builders fold into sections (22 Oct 2026): a stop points at its
  // section's header, which is on screen open or closed; a builder without
  // folds (the video models) skips the stop or falls through to the control.
  {
    target: '#builder-mount [data-fold="presets"] .fold-head',
    title: 'Sections',
    text: 'The rest of the builder folds away, and all of it is optional. Click a section\'s header to open or close it; closed, it still shows what you picked. This one holds quality, style and the picture\'s shape.',
  },
  {
    target: '#builder-mount [data-fold="output"]',
    title: 'Output options',
    text: 'How long the prompt should run, and which parts of it you want back.',
  },
  {
    target: '#builder-mount [data-fold="verbatim"]',
    title: 'Kept as written',
    text: 'Anything that must appear exactly as you typed it, like a LoRA trigger word. The brief gets rewritten; this does not.',
  },
  {
    target: '#builder-mount [data-fold="camera"]',
    title: 'Camera',
    text: 'Where the camera stands and how close it is.',
  },
  {
    target: '#builder-mount [data-fold="lighting"]',
    title: 'Lighting',
    text: 'How bright the picture is and where the light comes from.',
  },
  {
    target: '#builder-mount [data-fold="tags"], #builder-mount [data-bind="tag_search"]',
    title: 'Tags',
    text: 'Search real Danbooru tags and click to add them. Pick a character and what they look like comes up as chips you can add too.',
  },
  {
    target: '#builder-mount [data-fold="refs"], #builder-mount [data-bind="image_reference"], #builder-mount [data-bind="reference_list"]',
    title: 'Reference pictures',
    text: 'Add a picture and the model looks at it before it writes. Say what it is for and what to keep from it.',
  },
  {
    target: '#builder-mount [data-bind="generate"]',
    title: 'Generate',
    text: 'Writes the prompt. It streams into Output section by section, and Stop cancels it.',
  },
  {
    target: '#output-panel',
    title: 'Output',
    text: 'Your prompt lands here. Copy one section or all of it, Save it to your Library, or type a change and Refine to fix one thing without starting over.',
  },
  {
    target: '#render-section',
    title: 'Render',
    text: 'Send the finished prompt to ComfyUI and see the picture right here, with your own presets and LoRAs.',
  },
  {
    target: '#history-panel',
    title: 'History',
    text: 'This session is everything you have generated since you signed in, gone when you sign out. Library is what you saved, and only you see it.',
  },
  {
    target: '.main-tab[data-tab="analysis"]',
    title: 'Media Analysis',
    text: 'Drop in a picture to get its tags or a description, or a video to pick a frame from it, then send them straight into the builder.',
  },
  {
    target: '.main-tab[data-tab="lora"]',
    title: 'LoRA Training',
    text: 'Caption a set of pictures for a LoRA here. With training switched on in Setup, you can train it here too.',
  },
  {
    target: '.main-tab[data-tab="edit"]',
    title: 'Edit',
    text: 'Change a picture by saying what to change.',
  },
  {
    target: '.main-tab[data-tab="chat"]',
    title: 'Chat',
    text: 'Talk to the local models about anything. Your conversations are kept for 14 days, or for good if you lock one.',
  },
  {
    target: '.main-tab[data-tab="bench"]',
    title: 'Benchmarks',
    text: 'Speed measurements taken on this machine, so you can see how each model does here.',
  },
  {
    target: '.main-tab[data-tab="shared"]',
    title: 'Pinboard',
    text: 'Pictures and the prompts that made them, put up by anyone on this server and seen by all of them.',
  },
  {
    target: '#btn-warmup',
    title: 'Warm up',
    text: 'Loads the model before you need it, so your first prompt does not wait. The dot by the logo says what is loaded.',
  },
  {
    target: '#btn-accounts',
    title: 'Accounts',
    text: 'Everyone with an account here. New people wait for your approval, and this is where you give it.',
  },
  {
    target: '#btn-backend',
    title: 'Setup',
    text: 'The LLM server, plus anything you skipped at the start: image taggers, rendering, training and who can connect.',
  },
  {
    target: '#people-tab',
    title: 'People',
    text: 'Who else is on right now, and what the machine is busy with.',
  },
  {
    target: '#whoami',
    title: 'Settings',
    text: 'Your name opens your settings: the model you open on, colours, language and password. This tour is in there too, whenever you want it again.',
  },
];
