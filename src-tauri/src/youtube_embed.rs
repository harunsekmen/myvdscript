use tiny_http::{Header, Method, Response, Server, StatusCode};

pub struct EmbedAddress(String);

impl EmbedAddress {
    pub fn start() -> Result<Self, String> {
        let server = Server::http(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        let origin = format!("http://{}", server.server_addr());
        let route = format!("/player/{}/", uuid::Uuid::new_v4().simple());
        let base = format!("{origin}{route}");
        std::thread::Builder::new()
            .name("youtube-embed".into())
            .spawn(move || {
                for request in server.incoming_requests() {
                    let id = request.url().strip_prefix(&route).filter(|id| valid_id(id));
                    if let (Method::Get, Some(id)) = (request.method(), id) {
                        let page = include_str!("youtube_embed.html").replace("VIDEO_ID", id);
                        let content_type = Header::from_bytes("Content-Type", "text/html; charset=utf-8")
                            .expect("valid content type");
                        let _ = request.respond(Response::from_string(page).with_header(content_type));
                    } else {
                        let _ = request.respond(Response::empty(StatusCode(404)));
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self(base))
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[tauri::command]
pub fn youtube_embed_base(address: tauri::State<'_, EmbedAddress>) -> String {
    address.0.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serves_only_valid_video_ids_at_the_session_route() {
        let base = EmbedAddress::start().unwrap().0;
        let client = reqwest::Client::new();
        let page = client.get(format!("{base}8Pg6G5h05hk")).send().await.unwrap();
        assert_eq!(page.status(), 200);
        assert!(page.text().await.unwrap().contains("/embed/8Pg6G5h05hk?"));

        let invalid = client.get(format!("{base}8Pg6G5h05hk?x=1")).send().await.unwrap();
        assert_eq!(invalid.status(), 404);

        let other_route = reqwest::Url::parse(&base).unwrap().join("/").unwrap();
        let response = client.get(other_route).send().await.unwrap();
        assert_eq!(response.status(), 404);
    }
}
