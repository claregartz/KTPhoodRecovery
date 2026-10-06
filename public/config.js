// Connection details for our Supabase project.
//
// Find these in the Supabase dashboard: Project Settings → API.
// The anon key is designed to be public (it ships inside the app), so it's
// fine to commit. NEVER put the service_role key here: it bypasses every
// rule in supabase/schema.sql.
window.FREEDGE_CONFIG = {
  supabaseUrl: 'PASTE_PROJECT_URL_HERE',
  supabaseAnonKey: 'PASTE_ANON_KEY_HERE',
};
