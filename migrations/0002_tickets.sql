-- phase: expand
-- OpenVibe.Help: support tickets and their conversation. A ticket is one conversation from the moment it is
-- opened: the first message is the person's description, every later one is a reply from either side. Nothing
-- written here is ever a credential, a key or a token, and a page URL a person pastes is stored as text only —
-- this service never fetches it.

CREATE TABLE help_tickets (
    id         text COLLATE "C" PRIMARY KEY,                  -- tkt_<ULID>
    requester  text COLLATE "C" NOT NULL,                     -- user:usr_…, the person who opened it
    site       text COLLATE "C" NOT NULL,                     -- a catalog domain, or '' for "not about one site"
    subject    text NOT NULL,
    state      text COLLATE "C" NOT NULL,                     -- open | waiting | solved
    page_url   text,                                          -- where they were, as they typed it; text only
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
CREATE INDEX help_tickets_by_requester ON help_tickets (requester, id DESC);
CREATE INDEX help_tickets_by_state ON help_tickets (state, id DESC);
CREATE INDEX help_tickets_by_site ON help_tickets (site, id DESC);

CREATE TABLE help_messages (
    id         text COLLATE "C" PRIMARY KEY,                  -- msg_<ULID>
    ticket_id  text COLLATE "C" NOT NULL REFERENCES help_tickets (id) ON DELETE CASCADE,
    author     text COLLATE "C" NOT NULL,                     -- user:usr_… of whoever wrote it
    role       text COLLATE "C" NOT NULL,                     -- person | staff (which side wrote it)
    body       text NOT NULL,
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX help_messages_by_ticket ON help_messages (ticket_id, id);
