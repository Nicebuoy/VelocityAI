export interface DemoProjectScript {
  name: string
  sourceCode: string
}

export const DEMO_PROJECT_SCRIPTS: DemoProjectScript[] = [
  {
    name: 'StarterPlayer/StarterPlayerScripts/TargetTracker.client.lua',
    sourceCode: `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
local localPlayer = Players.LocalPlayer
local targetEvent = ReplicatedStorage:WaitForChild("TargetUpdate")
local raycastParams = RaycastParams.new()

local function startTracking()
  RunService.Heartbeat:Connect(function()
    local character = localPlayer.Character
    local root = character and character:FindFirstChild("HumanoidRootPart")
    if not root then return end

    for _, targetPlayer in Players:GetPlayers() do
      if targetPlayer ~= localPlayer then
        local targetCharacter = targetPlayer.Character
        local targetRoot = targetCharacter and targetCharacter:FindFirstChild("HumanoidRootPart")
        if targetRoot then
          local direction = targetRoot.Position - root.Position
          local hit = Workspace:Raycast(root.Position, direction, raycastParams)
          if not hit then
            targetEvent:FireServer(targetPlayer.UserId, direction.Unit)
          end
        end
      end
    end
  end)
end

localPlayer.CharacterAdded:Connect(startTracking)
if localPlayer.Character then
  startTracking()
end`,
  },
  {
    name: 'ServerScriptService/Combat/HitScan.server.lua',
    sourceCode: `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")
local shotEvent = ReplicatedStorage:WaitForChild("ShotFired")

shotEvent.OnServerEvent:Connect(function(shooter, origin, direction)
  for _, targetPlayer in Players:GetPlayers() do
    local character = targetPlayer.Character
    local humanoid = character and character:FindFirstChildOfClass("Humanoid")
    if targetPlayer ~= shooter and humanoid then
      local raycastParams = RaycastParams.new()
      raycastParams.FilterDescendantsInstances = { shooter.Character }
      local hit = Workspace:Raycast(origin, direction, raycastParams)
      if hit and hit.Instance:IsDescendantOf(character) then
        humanoid:TakeDamage(10)
      end
    end
  end
end)`,
  },
  {
    name: 'ServerScriptService/World/PropPulse.server.lua',
    sourceCode: `local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

RunService.Heartbeat:Connect(function(deltaTime)
  for _, instance in Workspace:GetDescendants() do
    if instance:IsA("BasePart") and instance:GetAttribute("PulseProp") then
      instance.CFrame = instance.CFrame * CFrame.Angles(0, math.rad(30 * deltaTime), 0)
    end
  end
end)`,
  },
  {
    name: 'StarterPlayer/StarterPlayerScripts/PickupScanner.client.lua',
    sourceCode: `local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local localPlayer = Players.LocalPlayer
local pickupEvent = ReplicatedStorage:WaitForChild("CollectPickup")

local function trackCharacter(character)
  local root = character:WaitForChild("HumanoidRootPart")
  RunService.Stepped:Connect(function()
    for _, pickup in CollectionService:GetTagged("Pickup") do
      if (root.Position - pickup.Position).Magnitude < 12 then
        pickupEvent:FireServer(pickup)
      end
    end
  end)
end

localPlayer.CharacterAdded:Connect(trackCharacter)
if localPlayer.Character then
  trackCharacter(localPlayer.Character)
end`,
  },
]
