//! Running helper programs (curl, op, git) in the background: no console window, and a Job
//! object so that stopping one also stops everything it started.

use std::process::{Child, Command, Output};
use std::sync::mpsc;
use std::time::Duration;

pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// A group of processes. Ending the job ends all of them, including ones they started (the curl
/// that `op run` starts, the ssh that git starts); closing it does the same, so nothing outlives it.
pub struct Job(windows_sys::Win32::Foundation::HANDLE);

// The handle is only used for job calls, which may come from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> Option<Job> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Job(handle))
        }
    }

    pub fn assign(&self, child: &Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0, child.as_raw_handle() as _) != 0 }
    }

    pub fn kill(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Runs `cmd` to the end, or stops it (and what it started) after `limit`: then `Ok(None)`.
/// stdin is closed, so a program that wants to ask something fails instead of waiting.
pub fn output_within(mut cmd: Command, limit: Duration) -> Result<Option<Output>, String> {
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let job = Job::new().ok_or("Could not start a process")?;
    let child = cmd.spawn().map_err(|e| format!("Could not run {}: {e}", cmd.get_program().to_string_lossy()))?;
    job.assign(&child);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(limit) {
        Ok(out) => out.map(Some).map_err(|e| e.to_string()),
        Err(_) => {
            job.kill();
            let _ = rx.recv();
            Ok(None)
        }
    }
}
