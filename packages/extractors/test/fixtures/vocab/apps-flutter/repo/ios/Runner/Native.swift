import Foundation
import Alamofire

func track(_ event: String) {
    var request = URLRequest(url: URL(string: "https://events.harbor.example/track")!)
    request.httpMethod = "POST"
    URLSession.shared.dataTask(with: request).resume()
    AF.request("https://api.harbor.example/v2/stores", method: .get)
}
