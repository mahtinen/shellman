//! Shellman's own Telnet client, like PuTTY's and MobaXterm's: keys go to the host as the terminal
//! sends them, so Backspace arrives as DEL, with Ctrl+H as an option for hosts that want that.
//! (Windows' telnet.exe, run in a pseudoconsole, didn't pass Backspace on in a way devices took.)
//!
//! The protocol part (`Telnet`) only turns bytes into bytes and is tested on its own; `connect`
//! runs it over a TCP connection.
//!
//! Negotiation, as PuTTY's "passive" mode does it: Shellman says nothing until the host negotiates,
//! since some devices are plain text services that would read the codes as typing (a login then
//! fails). Once the host starts, Shellman offers window size (NAWS) and terminal type, and asks the
//! host to echo and to drop go-ahead (character at a time). Anything else the host asks for is
//! refused. An option is only answered when its state changes, so the two sides can't loop.
//!
//! Many devices don't echo and expect whole lines. Then, like PuTTY's "auto" local echo and line
//! editing, Shellman shows what is typed itself, lets Backspace and Ctrl+U edit the line, and sends it
//! on Enter. Once the host echoes and goes character at a time, keys go out as they are typed.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SE: u8 = 240;
const IP: u8 = 244;
const SB: u8 = 250;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;
const IAC: u8 = 255;

const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

/// What the terminal type is said to be. Old devices know "XTERM"; PuTTY says the same.
const TERMINAL_TYPE: &[u8] = b"XTERM";

/// What Backspace sends.
#[derive(serde::Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Backspace {
    /// DEL (0x7f), as xterm, PuTTY and MobaXterm send it.
    #[default]
    Delete,
    /// Ctrl+H (0x08), for hosts that expect that.
    CtrlH,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Data,
    /// After IAC.
    Iac,
    /// After IAC WILL/WONT/DO/DONT: the option comes next.
    Option(u8),
    /// Inside IAC SB ... IAC SE.
    Sub,
    /// After IAC inside a subnegotiation.
    SubIac,
}

/// Where one side stands on one option.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Opt {
    #[default]
    No,
    /// Shellman asked and waits for the answer.
    Asked,
    Yes,
}

/// The protocol state of one connection.
pub struct Telnet {
    state: State,
    sub: Vec<u8>,
    /// Options Shellman does itself (WILL).
    local: [Opt; 256],
    /// Options the host does (its WILL, Shellman's DO).
    remote: [Opt; 256],
    /// The last byte of data was CR: a NUL after it is padding (CR NUL means just CR).
    after_cr: bool,
    cols: u16,
    rows: u16,
    backspace: Backspace,
    /// The line being typed, while Shellman edits lines itself.
    line: Vec<u8>,
    /// The host has negotiated, and Shellman has made its own offers.
    offered: bool,
    /// The host's last output ended in a password prompt: the next line isn't shown.
    secret: bool,
}

impl Telnet {
    pub fn new(cols: u16, rows: u16, backspace: Backspace) -> Telnet {
        Telnet {
            state: State::Data,
            sub: Vec::new(),
            local: [Opt::No; 256],
            remote: [Opt::No; 256],
            after_cr: false,
            cols,
            rows,
            backspace,
            line: Vec::new(),
            offered: false,
            secret: false,
        }
    }

    /// Shellman's offers, once the host has negotiated: it will report window size and terminal
    /// type, and would like the host to echo and to go character at a time.
    fn offer(&mut self, out: &mut Vec<u8>) {
        if self.offered {
            return;
        }
        self.offered = true;
        for opt in [NAWS, TTYPE, SGA] {
            if self.local[opt as usize] == Opt::No {
                self.local[opt as usize] = Opt::Asked;
                out.extend([IAC, WILL, opt]);
            }
        }
        for opt in [ECHO, SGA] {
            if self.remote[opt as usize] == Opt::No {
                self.remote[opt as usize] = Opt::Asked;
                out.extend([IAC, DO, opt]);
            }
        }
    }

    /// Until the host echoes, Shellman shows what is typed.
    fn local_echo(&self) -> bool {
        self.remote[ECHO as usize] != Opt::Yes
    }

    /// Until both sides drop go-ahead, Shellman edits whole lines and sends them on Enter (as PuTTY).
    fn line_mode(&self) -> bool {
        !(self.local[SGA as usize] == Opt::Yes && self.remote[SGA as usize] == Opt::Yes)
    }

    /// Splits what came from the host into text for the terminal and replies to send back.
    pub fn receive(&mut self, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::with_capacity(input.len());
        let mut reply = Vec::new();
        for &b in input {
            match self.state {
                State::Data => {
                    if b == IAC {
                        self.state = State::Iac;
                    } else if !(b == 0 && self.after_cr) {
                        data.push(b);
                        self.after_cr = b == b'\r';
                    } else {
                        self.after_cr = false;
                    }
                }
                State::Iac => {
                    self.state = State::Data;
                    match b {
                        IAC => {
                            data.push(IAC);
                            self.after_cr = false;
                        }
                        WILL | WONT | DO | DONT => {
                            self.offer(&mut reply);
                            self.state = State::Option(b);
                        }
                        SB => {
                            self.offer(&mut reply);
                            self.sub.clear();
                            self.state = State::Sub;
                        }
                        // NOP, go-ahead, data mark, break and the like: nothing to do.
                        _ => {}
                    }
                }
                State::Option(verb) => {
                    self.state = State::Data;
                    self.negotiate(verb, b, &mut reply);
                }
                State::Sub => {
                    if b == IAC {
                        self.state = State::SubIac;
                    } else {
                        self.sub.push(b);
                    }
                }
                State::SubIac => match b {
                    SE => {
                        self.state = State::Data;
                        self.subnegotiation(&mut reply);
                    }
                    IAC => {
                        self.sub.push(IAC);
                        self.state = State::Sub;
                    }
                    // Broken subnegotiation: drop it.
                    _ => self.state = State::Data,
                },
            }
        }
        if !data.is_empty() {
            self.secret = asks_password(&data);
        }
        (data, reply)
    }

    fn negotiate(&mut self, verb: u8, opt: u8, reply: &mut Vec<u8>) {
        let i = opt as usize;
        match verb {
            DO => {
                if !matches!(opt, NAWS | TTYPE | SGA) {
                    reply.extend([IAC, WONT, opt]);
                    return;
                }
                // An answer to Shellman's WILL needs no reply; a new request is agreed to.
                if self.local[i] == Opt::No {
                    reply.extend([IAC, WILL, opt]);
                }
                let was = self.local[i];
                self.local[i] = Opt::Yes;
                if opt == NAWS && was != Opt::Yes {
                    reply.extend(self.window_size());
                }
            }
            DONT => {
                if self.local[i] == Opt::Yes {
                    reply.extend([IAC, WONT, opt]);
                }
                self.local[i] = Opt::No;
            }
            WILL => {
                if !matches!(opt, ECHO | SGA) {
                    reply.extend([IAC, DONT, opt]);
                    return;
                }
                if self.remote[i] == Opt::No {
                    reply.extend([IAC, DO, opt]);
                }
                self.remote[i] = Opt::Yes;
            }
            WONT => {
                if self.remote[i] == Opt::Yes {
                    reply.extend([IAC, DONT, opt]);
                }
                self.remote[i] = Opt::No;
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        if self.sub.first() == Some(&TTYPE) && self.sub.get(1) == Some(&TTYPE_SEND) && self.local[TTYPE as usize] == Opt::Yes {
            reply.extend([IAC, SB, TTYPE, TTYPE_IS]);
            reply.extend(TERMINAL_TYPE);
            reply.extend([IAC, SE]);
        }
    }

    /// The window size message, once the host has agreed to hear it.
    fn window_size(&self) -> Vec<u8> {
        let mut out = vec![IAC, SB, NAWS];
        for n in [self.cols, self.rows] {
            for b in n.to_be_bytes() {
                out.push(b);
                // A 255 in the numbers is doubled, like everywhere else.
                if b == IAC {
                    out.push(IAC);
                }
            }
        }
        out.extend([IAC, SE]);
        out
    }

    /// The terminal changed size: what to tell the host (nothing if it didn't ask).
    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.cols = cols;
        self.rows = rows;
        if self.local[NAWS as usize] == Opt::Yes {
            self.window_size()
        } else {
            Vec::new()
        }
    }

    /// Keys typed in the terminal: what goes to the host, and what Shellman shows itself (when the
    /// host doesn't echo). Enter is Telnet's new line (CR LF), as in PuTTY; a 255 byte is doubled.
    pub fn send(&mut self, keys: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut out = Vec::with_capacity(keys.len() + 4);
        let mut screen = Vec::new();
        // A password typed at the host's prompt isn't shown, as the host itself wouldn't echo it.
        let echo = self.local_echo() && !self.secret;
        if self.line_mode() {
            // Arrows and other keys that send a sequence have nothing to do in a line being typed.
            if keys.first() == Some(&0x1b) {
                return (out, screen);
            }
            for &b in keys {
                match b {
                    b'\r' | b'\n' => {
                        put(&mut out, &self.line);
                        self.line.clear();
                        out.extend(b"\r\n");
                        if self.local_echo() {
                            screen.extend(b"\r\n");
                        }
                        self.secret = false;
                    }
                    0x7f | 0x08 => {
                        if erase_char(&mut self.line) && echo {
                            screen.extend(b"\x08 \x08");
                        }
                    }
                    // Ctrl+U: the whole line; Ctrl+W: the last word.
                    0x15 | 0x17 => {
                        let keep = if b == 0x15 { 0 } else { word_start(&self.line) };
                        while self.line.len() > keep {
                            if erase_char(&mut self.line) && echo {
                                screen.extend(b"\x08 \x08");
                            }
                        }
                    }
                    // Ctrl+C: drop the line and tell the host to interrupt, as PuTTY does.
                    0x03 => {
                        self.line.clear();
                        out.extend([IAC, IP]);
                        if echo {
                            screen.extend(b"^C\r\n");
                        }
                    }
                    // Other control keys (Ctrl+D, Ctrl+Z, ...) go out right away with the line so far.
                    0x00..=0x1f if b != b'\t' => {
                        put(&mut out, &self.line);
                        self.line.clear();
                        out.push(b);
                    }
                    _ => {
                        self.line.push(b);
                        if echo {
                            screen.push(b);
                        }
                    }
                }
            }
            return (out, screen);
        }
        for &b in keys {
            match b {
                b'\r' => out.extend(b"\r\n"),
                0x7f if self.backspace == Backspace::CtrlH => out.push(0x08),
                IAC => out.extend([IAC, IAC]),
                _ => out.push(b),
            }
            if echo {
                match b {
                    b'\r' => screen.extend(b"\r\n"),
                    0x7f | 0x08 => screen.extend(b"\x08 \x08"),
                    0x00..=0x1f => {}
                    _ => screen.push(b),
                }
            }
        }
        (out, screen)
    }
}

/// Whether the host's output ends in a password prompt ("Password:", "password for bob: ").
fn asks_password(data: &[u8]) -> bool {
    let text = String::from_utf8_lossy(data).to_lowercase();
    let last = text.trim_end().rsplit(['\r', '\n']).next().unwrap_or("");
    last.ends_with(':') && (last.contains("password") || last.contains("passcode") || last.contains("passphrase"))
}

/// Adds typed text to what goes out, doubling 255 bytes.
fn put(out: &mut Vec<u8>, text: &[u8]) {
    for &b in text {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
}

/// Removes the last character (all bytes of a UTF-8 one); false when there was none.
fn erase_char(line: &mut Vec<u8>) -> bool {
    let Some(mut last) = line.pop() else { return false };
    while last & 0xc0 == 0x80 {
        match line.pop() {
            Some(b) => last = b,
            None => break,
        }
    }
    true
}

/// Where the last word of the line starts (after trailing spaces).
fn word_start(line: &[u8]) -> usize {
    let end = line.iter().rposition(|&b| b != b' ').map_or(0, |i| i + 1);
    line[..end].iter().rposition(|&b| b == b' ').map_or(0, |i| i + 1)
}

/// An open connection: the socket and its protocol state, shared by the threads that read and write.
pub struct Link {
    stream: TcpStream,
    telnet: Mutex<Telnet>,
}

impl Link {
    /// Sends keys typed in the terminal. Returns what Shellman shows itself while the host doesn't echo.
    pub fn write_keys(&self, keys: &[u8]) -> std::io::Result<Vec<u8>> {
        let (bytes, screen) = self.telnet.lock().unwrap().send(keys);
        if !bytes.is_empty() {
            (&self.stream).write_all(&bytes)?;
        }
        Ok(screen)
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let bytes = self.telnet.lock().unwrap().resize(cols, rows);
        if !bytes.is_empty() {
            let _ = (&self.stream).write_all(&bytes);
        }
    }

    /// Ends the connection; the reader then sees the end and the terminal shows it as closed.
    pub fn close(&self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }

    /// Reads from the host until the connection ends, handing text to `output` and answering
    /// negotiation itself.
    pub fn read_loop(&self, mut output: impl FnMut(&[u8]) -> bool) {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match (&self.stream).read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let (data, reply) = self.telnet.lock().unwrap().receive(&buf[..n]);
                    if !reply.is_empty() && (&self.stream).write_all(&reply).is_err() {
                        break;
                    }
                    if !data.is_empty() && !output(&data) {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }
}

/// Connects to `host:port` and greets it. Tries each address the name has, 15 seconds each.
pub fn connect(host: &str, port: u16, cols: u16, rows: u16, backspace: Backspace) -> Result<Arc<Link>, String> {
    let target = format!("{}:{port}", if host.contains(':') { format!("[{host}]") } else { host.to_string() });
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Could not find {host}: {e}"))?
        .collect();
    let mut last = format!("Could not find {host}");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(15)) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                let telnet = Telnet::new(cols, rows, backspace);
                return Ok(Arc::new(Link { stream, telnet: Mutex::new(telnet) }));
            }
            Err(e) => last = format!("Could not connect to {target}: {e}"),
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// After the host's first negotiation (about an option nobody uses), so Shellman has made its offers.
    fn telnet() -> Telnet {
        let mut t = Telnet::new(80, 24, Backspace::Delete);
        let offers = t.receive(&[IAC, WONT, 99]).1;
        assert_eq!(offers, OFFERS);
        t
    }

    const OFFERS: [u8; 15] = [IAC, WILL, NAWS, IAC, WILL, TTYPE, IAC, WILL, SGA, IAC, DO, ECHO, IAC, DO, SGA];

    #[test]
    fn says_nothing_until_the_host_negotiates() {
        let mut t = Telnet::new(80, 24, Backspace::Delete);
        // A plain text service: no codes go out, only the typing.
        assert_eq!(t.receive(b"\n\nLogin: "), (b"\n\nLogin: ".to_vec(), vec![]));
        assert_eq!(t.send(b"user\r"), (b"user\r\n".to_vec(), b"user\r\n".to_vec()));
        // A telnet server asks something: then Shellman makes its offers too, once.
        let mut t = Telnet::new(80, 24, Backspace::Delete);
        let reply = t.receive(&[IAC, DO, NAWS]).1;
        let mut want = OFFERS.to_vec();
        want.extend([IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE]);
        assert_eq!(reply, want);
        assert_eq!(t.receive(&[IAC, DO, TTYPE]).1, Vec::<u8>::new());
    }

    #[test]
    fn plain_text_passes_through() {
        let mut t = telnet();
        assert_eq!(t.receive(b"login: "), (b"login: ".to_vec(), vec![]));
    }

    #[test]
    fn answers_window_size_and_terminal_type() {
        let mut t = telnet();
        // The host agrees to NAWS: the size goes out right away (an answer needs no WILL again).
        let (data, reply) = t.receive(&[IAC, DO, NAWS]);
        assert!(data.is_empty());
        assert_eq!(reply, [IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE]);
        // The host asks for the terminal type.
        let (_, reply) = t.receive(&[IAC, DO, TTYPE, IAC, SB, TTYPE, TTYPE_SEND, IAC, SE]);
        let mut want = vec![IAC, SB, TTYPE, TTYPE_IS];
        want.extend(b"XTERM");
        want.extend([IAC, SE]);
        assert_eq!(reply, want);
        // Resizing tells the host the new size.
        assert_eq!(t.resize(132, 255), [IAC, SB, NAWS, 0, 132, 0, 255, 255, IAC, SE]);
    }

    #[test]
    fn acks_are_not_answered_and_unknown_options_are_refused() {
        let mut t = telnet();
        // The host agrees to echo and character mode, which Shellman asked for: no reply.
        assert_eq!(t.receive(&[IAC, WILL, ECHO, IAC, WILL, SGA]).1, Vec::<u8>::new());
        // Options Shellman doesn't do are refused.
        assert_eq!(t.receive(&[IAC, DO, 39]).1, [IAC, WONT, 39]);
        assert_eq!(t.receive(&[IAC, WILL, 5]).1, [IAC, DONT, 5]);
        // The host stops echoing: agreed once, not again.
        assert_eq!(t.receive(&[IAC, WONT, ECHO]).1, [IAC, DONT, ECHO]);
        assert_eq!(t.receive(&[IAC, WONT, ECHO]).1, Vec::<u8>::new());
        // And starts again.
        assert_eq!(t.receive(&[IAC, WILL, ECHO]).1, [IAC, DO, ECHO]);
    }

    #[test]
    fn negotiation_split_across_reads_and_mixed_with_text() {
        let mut t = telnet();
        let (d1, r1) = t.receive(&[b'a', IAC]);
        let (d2, r2) = t.receive(&[DO]);
        let (d3, r3) = t.receive(&[39, b'b', IAC, IAC, b'c']);
        assert_eq!((d1, d2, d3), (b"a".to_vec(), vec![], vec![b'b', 255, b'c']));
        assert!(r1.is_empty() && r2.is_empty());
        assert_eq!(r3, [IAC, WONT, 39]);
    }

    #[test]
    fn carriage_return_padding_is_dropped() {
        let mut t = telnet();
        assert_eq!(t.receive(b"one\r\0two\r\nthree\0").0, b"one\rtwo\r\nthree\0".to_vec());
        // Across reads too.
        assert_eq!(t.receive(b"x\r").0, b"x\r".to_vec());
        assert_eq!(t.receive(b"\0y").0, b"y".to_vec());
    }

    /// A host that echoes and goes character at a time.
    fn character_mode(backspace: Backspace) -> Telnet {
        let mut t = Telnet::new(80, 24, backspace);
        t.receive(&[IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, SGA]);
        t
    }

    #[test]
    fn keys_go_out_as_typed_once_the_host_echoes() {
        let mut t = character_mode(Backspace::Delete);
        assert_eq!(t.send(b"ls\r"), (b"ls\r\n".to_vec(), vec![]));
        assert_eq!(t.send(&[b'a', 0x7f]), (vec![b'a', 0x7f], vec![]));
        assert_eq!(t.send(&[0xff]), (vec![IAC, IAC], vec![]));
        assert_eq!(t.send(b"\x1b[A"), (b"\x1b[A".to_vec(), vec![]));
        let mut ctrl_h = character_mode(Backspace::CtrlH);
        assert_eq!(ctrl_h.send(&[b'a', 0x7f]).0, [b'a', 0x08]);
    }

    #[test]
    fn edits_lines_itself_while_the_host_does_not_echo() {
        // The host never answers about echo or go-ahead: lines are typed here, like PuTTY's "auto".
        let mut t = telnet();
        assert_eq!(t.send(b"shw"), (vec![], b"shw".to_vec()));
        assert_eq!(t.send(&[0x7f]), (vec![], b"\x08 \x08".to_vec()));
        assert_eq!(t.send(b"ow ver"), (vec![], b"ow ver".to_vec()));
        // Enter sends the line as it now is.
        assert_eq!(t.send(b"\r"), (b"show ver\r\n".to_vec(), b"\r\n".to_vec()));
        // Backspace on an empty line does nothing; a multi-byte character goes at once.
        assert_eq!(t.send(&[0x7f]), (vec![], vec![]));
        t.send("ä".as_bytes());
        assert_eq!(t.send(&[0x7f]).1, b"\x08 \x08");
        assert_eq!(t.send(b"\r").0, b"\r\n");
        // Ctrl+W erases a word, Ctrl+U the line.
        t.send(b"one two");
        assert_eq!(t.send(&[0x17]).1, b"\x08 \x08".repeat(3));
        assert_eq!(t.send(&[0x15]).1, b"\x08 \x08".repeat(4));
        assert_eq!(t.send(b"\r").0, b"\r\n");
        // Ctrl+C drops the line and interrupts; arrows do nothing.
        t.send(b"oops");
        assert_eq!(t.send(&[0x03]), (vec![IAC, IP], b"^C\r\n".to_vec()));
        assert_eq!(t.send(b"\x1b[A"), (vec![], vec![]));
    }

    #[test]
    fn a_password_typed_at_its_prompt_is_not_shown() {
        let mut t = Telnet::new(80, 24, Backspace::Delete);
        t.receive(b"\n\nLogin: ");
        assert_eq!(t.send(b"bob\r").1, b"bob\r\n");
        t.receive(b"Password: ");
        assert_eq!(t.send(b"secret"), (vec![], vec![]));
        assert_eq!(t.send(&[0x7f]), (vec![], vec![]));
        assert_eq!(t.send(b"\r"), (b"secre\r\n".to_vec(), b"\r\n".to_vec()));
        // The next line shows again.
        t.receive(b"Welcome\r\n> ");
        assert_eq!(t.send(b"ls").1, b"ls");
        assert!(asks_password(b"[sudo] password for bob: "));
        assert!(!asks_password(b"Password changed.\r\n> "));
    }

    #[test]
    fn a_host_that_echoes_but_keeps_go_ahead_still_gets_lines() {
        let mut t = telnet();
        t.receive(&[IAC, WILL, ECHO, IAC, WONT, SGA, IAC, DONT, SGA]);
        // Not shown here (the host echoes), but still sent a line at a time.
        assert_eq!(t.send(b"ab"), (vec![], vec![]));
        assert_eq!(t.send(b"\r"), (b"ab\r\n".to_vec(), vec![]));
    }

    #[test]
    fn talks_to_a_server_that_wants_lines() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            // Agree to NAWS, then greet and wait for a line.
            s.write_all(&[IAC, DO, NAWS]).unwrap();
            s.write_all(b"login: ").unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 256];
            while !got.ends_with(b"\r\n") {
                let n = s.read(&mut buf).unwrap();
                assert!(n > 0, "closed early");
                got.extend(&buf[..n]);
            }
            got
        });
        let link = connect("127.0.0.1", port, 100, 40, Backspace::Delete).unwrap();
        let reader = link.clone();
        let text = Arc::new(Mutex::new(Vec::new()));
        let sink = text.clone();
        let read = std::thread::spawn(move || {
            reader.read_loop(|d| {
                sink.lock().unwrap().extend_from_slice(d);
                true
            })
        });
        // Once the prompt is there, the window size has gone out too. Typing "ab", Backspace, "c", Enter:
        // the host doesn't echo, so Shellman shows the typing and sends the finished line.
        let start = std::time::Instant::now();
        while text.lock().unwrap().as_slice() != b"login: " {
            assert!(start.elapsed() < Duration::from_secs(5), "no prompt");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(link.write_keys(b"ab\x7fc\r").unwrap(), b"ab\x08 \x08c\r\n");
        let got = server.join().unwrap();
        link.close();
        read.join().unwrap();
        // Shellman's offers (after the host's DO NAWS), the window size, then the finished line.
        let mut want = OFFERS.to_vec();
        want.extend([IAC, SB, NAWS, 0, 100, 0, 40, IAC, SE]);
        want.extend(b"ac\r\n");
        assert_eq!(got, want);
        assert_eq!(*text.lock().unwrap(), b"login: ");
    }

    #[test]
    fn unreachable_host_is_an_error() {
        // Nothing listens on port 1.
        let err = connect("127.0.0.1", 1, 80, 24, Backspace::Delete).err().unwrap();
        assert!(err.starts_with("Could not connect to 127.0.0.1:1"), "{err}");
    }
}
