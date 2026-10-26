Rails.application.routes.draw do
  get "/trails", to: "trails#index"
end
