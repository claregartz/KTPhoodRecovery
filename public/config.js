// Connection details for our Supabase project.
//
// Find these in the Supabase dashboard: Project Settings → API.
// The anon key is designed to be public (it ships inside the app), so it's
// fine to commit. NEVER put the service_role key here: it bypasses every
// rule in supabase/schema.sql.
window.FREEDGE_CONFIG = {
  supabaseUrl: 'https://lfaethyrqemcaamvdocb.supabase.co',
  supabaseAnonKey: 'sb_publishable_SWx76GbAguFbSAoQUmPQKQ_RetsIStb',
  // PostHog (usage analytics, see public/analytics.js). Find it in PostHog:
  // Project settings → Project API key. Like the anon key, it's meant to be
  // public: it can only send events, not read them.
  posthogKey: 'phc_CReLVAnnVU5fq6QyrVN35b9mHMUBV98RUotG66Z9SSBL',
  posthogHost: 'https://us.i.posthog.com',
};
